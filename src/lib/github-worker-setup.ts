import crypto from "node:crypto"
import { githubApi, GitHubApiError, listGitHubWorkflows } from "./github-oauth"
import { isWorkerWorkflow } from "./github-worker-workflow"

export { isWorkerWorkflow } from "./github-worker-workflow"

const WORKFLOW_DIRECTORY = "workers/migration-worker"
type Repo = {
  id: number; name: string; full_name: string; owner: { login: string }
  default_branch: string; fork?: boolean; archived?: boolean; disabled?: boolean
  permissions?: { admin?: boolean; push?: boolean }
  source?: { id: number }; parent?: { id: number }
  workerMarker?: boolean; workerWorkflowHint?: string
}
type State = {
  expires: number; source: Repo; page: number; matches: Repo[]
  phase: "scan" | "fork" | "ready"; selected?: Repo; scanned: number; forkRequested?: boolean
}
export type WorkerRepository = {
  id: string; owner: string; name: string; fullName: string; defaultBranch: string
}
const summarize = (repo: Repo): WorkerRepository => ({
  id: String(repo.id), owner: repo.owner.login, name: repo.name,
  fullName: repo.full_name, defaultBranch: repo.default_branch,
})
// Keep signed continuations small; GitHub repository responses contain many unrelated fields.
const compact = (repo: Repo): Repo => ({
  id: repo.id, name: repo.name, full_name: repo.full_name, owner: { login: repo.owner.login },
  default_branch: repo.default_branch, fork: repo.fork, archived: repo.archived, disabled: repo.disabled,
  permissions: { admin: repo.permissions?.admin, push: repo.permissions?.push },
  source: repo.source ? { id: repo.source.id } : undefined,
  parent: repo.parent ? { id: repo.parent.id } : undefined, workerMarker: repo.workerMarker,
  workerWorkflowHint: repo.workerWorkflowHint,
})
const repoPath = (repo: Repo) => `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`
const contentPath = (path: string) => path.split("/").map(encodeURIComponent).join("/")

async function getWorkerMarker(repo: Repo, token: string): Promise<{ workflow?: string } | null> {
  let file: { content?: string; encoding?: string }
  try {
    file = await githubApi(`${repoPath(repo)}/contents/.drive-worker.json?ref=${encodeURIComponent(repo.default_branch)}`, token)
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 404 || error.status === 409)) return null
    throw error
  }
  if (file.encoding !== "base64" || !file.content) return null
  try {
    const marker = JSON.parse(Buffer.from(file.content, "base64").toString("utf8")) as Record<string, unknown>
    const workflow = typeof marker.workflow === "string" ? marker.workflow.trim() : ""
    const validWorkflowHint = workflow === "auto" || /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(workflow)
    if (marker.schemaVersion !== 1 || marker.id !== "drive-migration-worker" || marker.directory !== WORKFLOW_DIRECTORY || !validWorkflowHint) return null
    return { workflow: workflow === "auto" ? undefined : workflow }
  } catch { return null }
}

type WorkflowFile = { id: string; name: string; path: string; state?: string; content: string }
class WorkerWorkflowPendingError extends Error {}

export async function assertWorkerWorkflow(input: { token: string; owner: string; repo: string; ref: string; workflow: string }) {
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(input.workflow)) throw new Error("Select a valid GitHub Actions workflow file")
  const file = await githubApi<{ type?: string; encoding?: string; content?: string }>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${contentPath(input.workflow)}?ref=${encodeURIComponent(input.ref)}`,
    input.token
  )
  if (file.type !== "file" || file.encoding !== "base64" || !file.content) throw new Error("Selected migration worker workflow is missing or unreadable")
  const content = Buffer.from(file.content, "base64").toString("utf8")
  if (!isWorkerWorkflow(content)) throw new Error("Selected workflow is not a compatible Drive Migration Worker workflow")
}

async function detectWorkerWorkflow(repo: Repo, token: string): Promise<WorkflowFile> {
  const workflows = await listGitHubWorkflows(token, repo.owner.login, repo.name, repo.default_branch)
  if (workflows.length === 0) throw new WorkerWorkflowPendingError("GitHub has not indexed a workflow for this repository yet")
  const compatible: WorkflowFile[] = []
  for (let offset = 0; offset < workflows.length; offset += 5) {
    const batch = await Promise.all(workflows.slice(offset, offset + 5).map(async (workflow) => {
      const file = await githubApi<{ type?: string; encoding?: string; content?: string }>(
        `${repoPath(repo)}/contents/${contentPath(workflow.path)}?ref=${encodeURIComponent(repo.default_branch)}`,
        token
      )
      if (file.type !== "file" || file.encoding !== "base64" || !file.content) return null
      const content = Buffer.from(file.content, "base64").toString("utf8")
      return isWorkerWorkflow(content) ? { ...workflow, content } : null
    }))
    compatible.push(...batch.filter((workflow): workflow is WorkflowFile => Boolean(workflow)))
  }
  const preferred = repo.workerWorkflowHint && repo.workerWorkflowHint !== "auto"
    ? compatible.find((workflow) => workflow.path === repo.workerWorkflowHint)
    : undefined
  if (preferred) return preferred
  const likely = compatible.filter((workflow) => /(?:worker|migration|drive)/i.test(`${workflow.name} ${workflow.path}`))
  if (likely.length === 1) return likely[0]
  if (compatible.length === 1) return compatible[0]
  if (compatible.length > 1) throw new Error("Multiple compatible worker workflows were found. Select the repository manually and choose its workflow.")
  throw new WorkerWorkflowPendingError("No compatible worker workflow is visible yet")
}
const signature = (payload: string, token: string) => crypto.createHmac("sha256", token).update(payload).digest("hex")
function encode(state: State, token: string) {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url")
  return `${payload}.${signature(payload, token)}`
}
function decode(cursor: string, token: string): State {
  if (cursor.length > 100000) throw new Error("Setup session is too large; restart detection")
  const [payload, mac] = cursor.split(".")
  const expected = signature(payload || "", token)
  if (!mac || mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    throw new Error("Setup session changed; restart detection")
  }
  const state = JSON.parse(Buffer.from(payload, "base64url").toString()) as State
  if (state.expires < Date.now()) throw new Error("Setup session expired; restart detection")
  return state
}

// Every continuation is authenticated: callers cannot skip the scan to create a fork.
// GitHub owns fork identity; replaying a fork request never chooses a new random name.
export async function advanceWorkerSetup(token: string, cursor?: string, selectedId?: string) {
  let state: State
  if (cursor) state = decode(cursor, token)
  else {
    const upstream = process.env.GITHUB_WORKER_SOURCE_REPO?.trim() || "iamnadith/Drive"
    if (!/^[\w.-]+\/[\w.-]+$/.test(upstream)) throw new Error("Invalid GITHUB_WORKER_SOURCE_REPO")
    const source = compact(await githubApi<Repo>(`/repos/${upstream}`, token))
    state = { expires: Date.now() + 60 * 60 * 1000, source, page: 1, matches: [], phase: "scan", scanned: 0 }
  }
  const pending = (message: string) => ({ status: "pending" as const, cursor: encode(state, token), message, scanned: state.scanned })
  if (state.phase === "scan") {
    if (state.page > 1000) throw new Error("Scan exceeded 10,000 repositories; narrow GitHub access and restart")
    const batch = await githubApi<Repo[]>(`/user/repos?per_page=10&sort=full_name&direction=asc&affiliation=owner,collaborator,organization_member&page=${state.page}`, token)
    // Ten details per request, in two bounded groups, keeps serverless calls short.
    for (let offset = 0; offset < batch.length; offset += 5) {
      const details = await Promise.all(batch.slice(offset, offset + 5).map(async (repo) => {
        // The upstream checkout is the template, not a worker destination.
        // Auto mode must create/select a fork when no worker fork exists;
        // using the upstream itself would also make every setup share one
        // repository unexpectedly. Manual mode remains available for an
        // intentional upstream selection.
        if (repo.id === state.source.id) return null
        const marker = await getWorkerMarker(repo, token)
        if (marker) return { ...repo, workerMarker: true, workerWorkflowHint: marker.workflow }
        if (!repo.fork) return null
        return githubApi<Repo>(repoPath(repo), token)
      }))
      for (const repo of details) {
        if (!repo) continue
        const network = state.source.source?.id || state.source.id
        if (!repo.workerMarker && repo.id !== state.source.id && repo.source?.id !== network && repo.parent?.id !== state.source.id) continue
        if (!state.matches.some((entry) => entry.id === repo.id)) state.matches.push(compact(repo))
      }
    }
    state.scanned += batch.length
    state.page++
    if (batch.length === 10) return pending(`Checked ${state.scanned} repositories...`)
    state.phase = state.matches.length ? "ready" : "fork"
  }
  if (state.phase === "fork") {
    const user = await githubApi<{ login: string }>("/user", token)
    // Stable alternate name avoids unrelated repositories named Drive without overwriting them.
    const name = `drive-worker-${state.source.id}`
    let existing: Repo | undefined
    try { existing = await githubApi<Repo>(`/repos/${encodeURIComponent(user.login)}/${name}`, token) }
    catch (error) { if (!(error instanceof GitHubApiError) || error.status !== 404) throw error }
    if (existing) {
      const network = state.source.source?.id || state.source.id
      if (existing.source?.id !== network && existing.parent?.id !== state.source.id) {
        throw new Error(`Repository ${user.login}/${name} already exists and is unrelated. Use manual selection or rename that repository.`)
      }
      state.selected = compact(existing)
    } else {
      try {
        state.selected = compact(await githubApi<Repo>(`${repoPath(state.source)}/forks`, token, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, default_branch_only: true }),
        }))
      } catch (error) {
        // A timed-out response may have created the fork. Reconcile by its
        // stable name before allowing another create request.
        if (!(error instanceof GitHubApiError) || error.status !== 422) throw error
        const reconciled = await githubApi<Repo>(`/repos/${encodeURIComponent(user.login)}/${name}`, token)
        const network = state.source.source?.id || state.source.id
        if (reconciled.source?.id !== network && reconciled.parent?.id !== state.source.id) throw error
        state.selected = compact(reconciled)
      }
    }
    state.forkRequested = true
    state.phase = "ready"
    return pending("Fork requested. Waiting for GitHub to prepare the repository...")
  }
  if (!state.selected) {
    const eligible = state.matches.filter((repo) => !repo.archived && !repo.disabled && repo.permissions?.admin && repo.permissions?.push)
    if (!eligible.length) throw new Error("Matching repositories exist, but none allow worker setup. Repository admin and push access are required; check GitHub permissions or use manual selection.")
    if (selectedId) {
      state.selected = eligible.find((repo) => String(repo.id) === selectedId)
      if (!state.selected) throw new Error("Choose a repository from the detected matches")
    } else if (eligible.length === 1) state.selected = eligible[0]
    else return { status: "choose" as const, cursor: encode(state, token), candidates: eligible.map(summarize), message: "Multiple matching repositories found. Choose the repository to use." }
  }
  let repo: Repo
  try { repo = await githubApi<Repo>(repoPath(state.selected), token) }
  catch (error) {
    if ((error instanceof GitHubApiError && (error.status === 404 || error.status === 409)) || (state.forkRequested && error instanceof WorkerWorkflowPendingError)) return pending("Waiting for GitHub to make the repository and workflow available...")
    throw error
  }
  if (repo.id !== state.selected.id || repo.archived || repo.disabled || !repo.permissions?.admin || !repo.permissions?.push) {
    throw new Error("Repository is unavailable or requires admin and push access. Check GitHub permissions.")
  }
  let workflow: WorkflowFile
  try {
    workflow = await detectWorkerWorkflow(repo, token)
    for (const path of [`${workflow.path}`, `${WORKFLOW_DIRECTORY}/package.json`, `${WORKFLOW_DIRECTORY}/package-lock.json`, `${WORKFLOW_DIRECTORY}/migration-worker.mjs`]) {
      const file = await githubApi<{ type?: string; encoding?: string; content?: string }>(`${repoPath(repo)}/contents/${contentPath(path)}?ref=${encodeURIComponent(repo.default_branch)}`, token)
      if (file.type !== "file") throw new Error(`Worker file ${path} is missing or invalid. Update the repository and retry.`)
    }
    if (workflow.state === "disabled_fork") {
      await githubApi(`${repoPath(repo)}/actions/workflows/${contentPath(workflow.path)}/enable`, token, { method: "PUT" })
      return pending("Enabling the worker workflow...")
    }
    if (workflow.state !== "active") throw new Error(`Worker workflow ${workflow.path} is disabled. Enable it in GitHub Actions and retry.`)
  } catch (error) {
    if ((error instanceof GitHubApiError && (error.status === 404 || error.status === 409)) || error instanceof WorkerWorkflowPendingError) {
      return pending("Waiting for worker files and workflow. If this persists, update the fork from upstream and retry.")
    }
    throw error
  }
  return { status: "ready" as const, repo: summarize(repo), workflow: workflow.path, message: `Selected ${repo.full_name} / ${workflow.path}` }
}
