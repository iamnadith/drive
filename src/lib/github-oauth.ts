import crypto from "crypto"

export const GITHUB_TOKEN_COOKIE = "githubOAuthToken"
export const GITHUB_STATE_COOKIE = "githubOAuthState"

type GitHubRepo = {
  id: number
  name: string
  full_name: string
  private: boolean
  default_branch?: string
  owner?: { login?: string }
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean }
}

type GitHubWorkflow = {
  id: number
  name: string
  path: string
  state?: string
}

type GitHubWorkflowRun = {
  id: number
  html_url?: string
  status?: string
  conclusion?: string | null
  event?: string
  head_branch?: string
  created_at?: string
  updated_at?: string
  display_title?: string
  name?: string
  run_number?: number
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required env var ${name}`)
  return value
}

export function getGitHubOAuthConfig() {
  return {
    clientId: requireEnv("GITHUB_CLIENT_ID"),
    clientSecret: requireEnv("GITHUB_CLIENT_SECRET"),
    appUrl: (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/+$/, ""),
  }
}

export function buildGitHubOAuthUrl(state: string): string {
  const { clientId, appUrl } = getGitHubOAuthConfig()
  if (!appUrl) throw new Error("Missing NEXT_PUBLIC_APP_URL or APP_URL")
  const url = new URL("https://github.com/login/oauth/authorize")
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", `${appUrl}/api/github/callback`)
  url.searchParams.set("scope", "repo workflow admin:repo_hook")
  url.searchParams.set("state", state)
  return url.toString()
}

async function githubApi<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : {}
  if (!response.ok) {
    const message =
      typeof json?.message === "string" ? json.message : `GitHub API request failed (${response.status})`
    throw new Error(message)
  }
  return json as T
}

export async function exchangeGitHubCode(code: string): Promise<string> {
  const { clientId, clientSecret, appUrl } = getGitHubOAuthConfig()
  if (!appUrl) throw new Error("Missing NEXT_PUBLIC_APP_URL or APP_URL")
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${appUrl}/api/github/callback`,
    }),
  })
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok || typeof json.access_token !== "string") {
    throw new Error(typeof json.error_description === "string" ? json.error_description : "Unable to exchange GitHub OAuth code")
  }
  return json.access_token
}

export async function listGitHubRepos(token: string): Promise<Array<{
  id: string
  owner: string
  name: string
  fullName: string
  private: boolean
  defaultBranch?: string
}>> {
  const repos = await githubApi<GitHubRepo[]>("/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", token)
  return repos
    .filter((repo) => Boolean(repo?.owner?.login) && Boolean(repo?.name))
    .map((repo) => ({
      id: String(repo.id),
      owner: String(repo.owner?.login ?? ""),
      name: String(repo.name),
      fullName: String(repo.full_name),
      private: Boolean(repo.private),
      defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : undefined,
    }))
}

export async function listGitHubWorkflows(token: string, owner: string, repo: string): Promise<Array<{
  id: string
  name: string
  path: string
  state?: string
}>> {
  const response = await githubApi<{ workflows?: GitHubWorkflow[] }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows?per_page=100`,
    token
  )
  return (Array.isArray(response.workflows) ? response.workflows : []).map((workflow) => ({
    id: String(workflow.id),
    name: workflow.name,
    path: workflow.path,
    state: workflow.state,
  }))
}

export async function setGitHubActionsSecret(input: {
  token: string
  owner: string
  repo: string
  name: string
  value: string
}): Promise<void> {
  const sodiumModule = await import("libsodium-wrappers")
  const sodium = (sodiumModule as { default?: typeof sodiumModule } & typeof sodiumModule).default ?? sodiumModule
  const keyResponse = await githubApi<{ key: string; key_id: string }>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/secrets/public-key`,
    input.token
  )
  await sodium.ready
  const publicKey = sodium.from_base64(keyResponse.key, sodium.base64_variants.ORIGINAL)
  const encryptedBytes = sodium.crypto_box_seal(input.value, publicKey)
  const encryptedValue = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL)

  await githubApi(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/secrets/${encodeURIComponent(input.name)}`,
    input.token,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: keyResponse.key_id,
      }),
    }
  )
}

export async function listGitHubWorkflowRuns(input: {
  token: string
  owner: string
  repo: string
  workflow: string
  branch?: string
  event?: string
  perPage?: number
}): Promise<Array<{
  id: string
  htmlUrl?: string
  status?: string
  conclusion?: string | null
  event?: string
  headBranch?: string
  createdAt?: string
  updatedAt?: string
  displayTitle?: string
  name?: string
  runNumber?: number
}>> {
  const query = new URLSearchParams()
  query.set("per_page", String(Math.max(1, Math.min(100, input.perPage ?? 20))))
  if (input.branch) query.set("branch", input.branch)
  if (input.event) query.set("event", input.event)

  const response = await githubApi<{ workflow_runs?: GitHubWorkflowRun[] }>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/workflows/${encodeURIComponent(input.workflow)}/runs?${query.toString()}`,
    input.token
  )
  return (Array.isArray(response.workflow_runs) ? response.workflow_runs : []).map((run) => ({
    id: String(run.id),
    htmlUrl: typeof run.html_url === "string" ? run.html_url : undefined,
    status: typeof run.status === "string" ? run.status : undefined,
    conclusion: typeof run.conclusion === "string" || run.conclusion === null ? run.conclusion : undefined,
    event: typeof run.event === "string" ? run.event : undefined,
    headBranch: typeof run.head_branch === "string" ? run.head_branch : undefined,
    createdAt: typeof run.created_at === "string" ? run.created_at : undefined,
    updatedAt: typeof run.updated_at === "string" ? run.updated_at : undefined,
    displayTitle: typeof run.display_title === "string" ? run.display_title : undefined,
    name: typeof run.name === "string" ? run.name : undefined,
    runNumber: typeof run.run_number === "number" ? run.run_number : undefined,
  }))
}

export async function getGitHubWorkflowRun(input: {
  token: string
  owner: string
  repo: string
  runId: string
}): Promise<{
  id: string
  htmlUrl?: string
  status?: string
  conclusion?: string | null
  event?: string
  headBranch?: string
  createdAt?: string
  updatedAt?: string
  displayTitle?: string
  name?: string
  runNumber?: number
}> {
  const run = await githubApi<GitHubWorkflowRun>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/runs/${encodeURIComponent(input.runId)}`,
    input.token
  )
  return {
    id: String(run.id),
    htmlUrl: typeof run.html_url === "string" ? run.html_url : undefined,
    status: typeof run.status === "string" ? run.status : undefined,
    conclusion: typeof run.conclusion === "string" || run.conclusion === null ? run.conclusion : undefined,
    event: typeof run.event === "string" ? run.event : undefined,
    headBranch: typeof run.head_branch === "string" ? run.head_branch : undefined,
    createdAt: typeof run.created_at === "string" ? run.created_at : undefined,
    updatedAt: typeof run.updated_at === "string" ? run.updated_at : undefined,
    displayTitle: typeof run.display_title === "string" ? run.display_title : undefined,
    name: typeof run.name === "string" ? run.name : undefined,
    runNumber: typeof run.run_number === "number" ? run.run_number : undefined,
  }
}

export function createGitHubOAuthState(): string {
  return crypto.randomBytes(24).toString("hex")
}
