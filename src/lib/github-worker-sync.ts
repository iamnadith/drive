import { isWorkerWorkflow } from "./github-worker-workflow"

const directory = "workers/migration-worker/"
export const DEFAULT_WORKER_SOURCE = "iamnadith/Drive"
type Repository = { id: number; default_branch: string; archived?: boolean; disabled?: boolean; source?: { id: number }; parent?: { id: number } }
type Entry = { path: string; mode: string; type: string; sha: string }
type Tree = { tree: Entry[]; truncated?: boolean }
type Commit = { sha: string; tree: { sha: string } }
class SyncError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
export class WorkerSyncPendingError extends Error {}

// Runtime-neutral: both the panel and the queue consumer use this exact gate.
export async function syncWorkerRepository(input: {
  token: string; owner: string; repo: string; workflow: string; sourceRepo?: string
}) {
  const sourceName = input.sourceRepo?.trim() || DEFAULT_WORKER_SOURCE
  if (!/^[\w.-]+\/[\w.-]+$/.test(sourceName)) throw new Error("Invalid GITHUB_WORKER_SOURCE_REPO")
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(input.workflow)) throw new Error("Invalid saved worker workflow")
  const sourcePath = `/repos/${sourceName.split("/").map(encodeURIComponent).join("/")}`
  const targetPath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`
  async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      method, cache: "no-store", signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${input.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Drive-Worker-Sync", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { throw new SyncError(`GitHub sync returned an invalid response (HTTP ${response.status})`, response.status) }
    if (!response.ok) throw new SyncError(`GitHub worker code sync HTTP ${response.status}: ${data.message || "request failed"}`, response.status)
    return data as T
  }
  const [source, target] = await Promise.all([api<Repository>(sourcePath), api<Repository>(targetPath)])
  if (target.archived || target.disabled) throw new Error("Worker repository is archived or disabled")
  const head = async (path: string, branch: string) => {
    const ref = await api<{ object: { sha: string } }>(`${path}/git/ref/heads/${encodeURIComponent(branch)}`)
    if (!/^[a-f0-9]{40,64}$/i.test(ref.object?.sha)) throw new Error("GitHub returned an invalid branch head")
    return ref.object.sha
  }
  const tree = async (path: string, sha: string) => {
    const commit = await api<Commit>(`${path}/git/commits/${sha}`)
    const result = await api<Tree>(`${path}/git/trees/${commit.tree.sha}?recursive=1`)
    if (result.truncated || !Array.isArray(result.tree)) throw new Error("GitHub worker tree is incomplete; dispatch stopped")
    return { commit, entries: result.tree }
  }
  const blobText = async (path: string, sha: string) => {
    const blob = await api<{ encoding: string; content: string }>(`${path}/git/blobs/${sha}`)
    if (blob.encoding !== "base64") throw new Error("GitHub returned an unreadable worker file")
    return new TextDecoder().decode(Uint8Array.from(atob(blob.content.replace(/\s/g, "")), c => c.charCodeAt(0)))
  }
  // Retry only proven concurrent branch movement. No force updates, cached success,
  // or dispatch on an incomplete scan, merge conflict, or permission failure.
  for (let attempt = 0; attempt < 3; attempt++) {
    const sourceSha = await head(sourcePath, source.default_branch)
    const sourceTree = await tree(sourcePath, sourceSha)
    let workflow = sourceTree.entries.find(e => e.path === input.workflow && e.type === "blob")
    if (!workflow) {
      const marker = sourceTree.entries.find(e => e.path === ".drive-worker.json" && e.type === "blob")
      if (!marker) throw new Error("Source repository has no worker workflow marker")
      const config = JSON.parse(await blobText(sourcePath, marker.sha)) as { workflow?: string }
      workflow = sourceTree.entries.find(e => e.path === config.workflow && e.type === "blob")
      if (!workflow && config.workflow === "auto") {
        const compatible: Entry[] = []
        for (const entry of sourceTree.entries.filter(e => e.type === "blob" && /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(e.path))) {
          if (isWorkerWorkflow(await blobText(sourcePath, entry.sha))) compatible.push(entry)
        }
        if (compatible.length !== 1) throw new Error("Source has multiple or no compatible worker workflows; select a source workflow explicitly")
        workflow = compatible[0]
      }
    }
    if (!workflow || !isWorkerWorkflow(await blobText(sourcePath, workflow.sha))) throw new Error("Source worker workflow is missing or incompatible")
    const wanted = sourceTree.entries.filter(e => e.path.startsWith(directory) && e.type !== "tree")
    for (const name of ["package.json", "package-lock.json", "migration-worker.mjs"]) {
      if (!wanted.some(e => e.path === directory + name && e.type === "blob")) throw new Error(`Source worker is missing ${name}`)
    }
    if (wanted.some(e => e.type !== "blob" || !["100644", "100755"].includes(e.mode))) throw new Error("Worker source must contain regular files")
    wanted.push({ ...workflow, path: input.workflow })
    let targetSha = await head(targetPath, target.default_branch)
    const sameNetwork = target.id === source.id || target.source?.id === (source.source?.id || source.id) || target.parent?.id === source.id
    if (sameNetwork && targetSha !== sourceSha) {
      const comparison = await api<{ behind_by: number }>(`${targetPath}/compare/${sourceSha}...${targetSha}`)
      if (!Number.isInteger(comparison.behind_by)) throw new Error("GitHub did not confirm source commit ancestry")
      if (comparison.behind_by > 0) {
        await api(`${targetPath}/merges`, "POST", { base: target.default_branch, head: sourceSha, commit_message: `Sync worker repository from ${sourceName}@${sourceSha}` })
        targetSha = await head(targetPath, target.default_branch)
      }
    }
    const targetTree = await tree(targetPath, targetSha)
    const changed = wanted.filter(e => !targetTree.entries.some(t => t.path === e.path && t.sha === e.sha && t.mode === e.mode))
    const removed = targetTree.entries.filter(e => e.path.startsWith(directory) && e.type !== "tree" && !wanted.some(s => s.path === e.path))
    if (changed.length || removed.length) {
      if (target.id === source.id) throw new Error("Source worker files changed during verification; retry dispatch")
      const entries: Array<{ path: string; mode: string; type: string; sha: string | null }> = []
      // Import blobs explicitly: marker-based copies may have unrelated Git history.
      for (const entry of changed) {
        const blob = await api<{ encoding: string; content: string }>(`${sourcePath}/git/blobs/${entry.sha}`)
        if (blob.encoding !== "base64") throw new Error("Unreadable source blob")
        const created = await api<{ sha: string }>(`${targetPath}/git/blobs`, "POST", { content: blob.content, encoding: "base64" })
        if (created.sha !== entry.sha) throw new Error("Worker blob integrity verification failed")
        entries.push({ path: entry.path, mode: entry.mode, type: "blob", sha: created.sha })
      }
      entries.push(...removed.map(e => ({ path: e.path, mode: e.mode, type: e.type, sha: null })))
      const createdTree = await api<{ sha: string }>(`${targetPath}/git/trees`, "POST", { base_tree: targetTree.commit.tree.sha, tree: entries })
      const commit = await api<{ sha: string }>(`${targetPath}/git/commits`, "POST", { message: `Sync worker files from ${sourceName}@${sourceSha}`, tree: createdTree.sha, parents: [targetSha] })
      try {
        await api(`${targetPath}/git/refs/heads/${encodeURIComponent(target.default_branch)}`, "PATCH", { sha: commit.sha, force: false })
      } catch (error) {
        if (error instanceof SyncError && [409, 422].includes(error.status) && await head(targetPath, target.default_branch) !== targetSha) continue
        throw error
      }
      targetSha = commit.sha
    }
    const verified = changed.length || removed.length ? await tree(targetPath, targetSha) : targetTree
    if (wanted.some(e => !verified.entries.some(t => t.path === e.path && t.sha === e.sha && t.mode === e.mode)) ||
        verified.entries.some(e => e.path.startsWith(directory) && e.type !== "tree" && !wanted.some(s => s.path === e.path))) {
      throw new Error("Worker repository did not match the latest source files; dispatch stopped")
    }
    if (sameNetwork && targetSha !== sourceSha) {
      const comparison = await api<{ behind_by: number }>(`${targetPath}/compare/${sourceSha}...${targetSha}`)
      if (comparison.behind_by !== 0) throw new Error("Worker repository is still missing upstream commits; dispatch stopped")
    }
    if (await head(sourcePath, source.default_branch) !== sourceSha || await head(targetPath, target.default_branch) !== targetSha) continue
    const workflowPath = `${targetPath}/actions/workflows/${encodeURIComponent(input.workflow.split("/").pop()!)}`
    let action: { state: string; path: string }
    try { action = await api(workflowPath) }
    catch (error) {
      if (error instanceof SyncError && error.status === 404) throw new WorkerSyncPendingError("Waiting for GitHub to index the synchronized worker workflow")
      throw error
    }
    if (action.path !== input.workflow) throw new WorkerSyncPendingError("Waiting for GitHub to index the synchronized worker workflow")
    if (action.state === "disabled_fork") {
      await api(`${workflowPath}/enable`, "PUT")
      action = await api<{ state: string; path: string }>(workflowPath)
      if (action.state === "disabled_fork") throw new WorkerSyncPendingError("Waiting for GitHub to enable the synchronized worker workflow")
    }
    if (action.state !== "active") throw new Error("Worker workflow is disabled or still being enabled; enable it in GitHub Actions and retry")
    return { sourceSha, targetSha, defaultBranch: target.default_branch }
  }
  throw new Error("Repository changed repeatedly during synchronization; retry worker dispatch")
}
