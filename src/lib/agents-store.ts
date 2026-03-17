import crypto from "crypto"
import { getSupabaseServerClient } from "./supabase"

export type AgentCategory = "worker" | "agent"
export type AgentProvider = "self_hosted" | "github_actions" | "local"
export type AgentStatus =
  | "pending_registration"
  | "online"
  | "offline"
  | "busy"
  | "dispatch_ready"
  | "disabled"
  | "error"

export type AgentCapability = "scan" | "verify" | "repair" | "bulk_migrate" | "diagnostics"

export type DriveAgent = {
  id: string
  name: string
  category: AgentCategory
  provider: AgentProvider
  status: AgentStatus
  capabilities: AgentCapability[]
  endpointDomain?: string
  endpointIp?: string
  githubRepoOwner?: string
  githubRepoName?: string
  githubWorkflowFile?: string
  githubRef?: string
  githubRepositoryId?: string
  notes?: string
  lastHeartbeatAt?: string
  lastSeenIp?: string
  lastSeenHost?: string
  lastSeenVersion?: string
  lastError?: string
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type DriveAgentRun = {
  id: string
  agentId: string
  runType: string
  status: "pending" | "running" | "completed" | "failed" | "canceled"
  externalRunId?: string
  jobReference?: string
  summary?: string
  payload?: Record<string, unknown>
  startedAt?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

type DriveAgentRow = {
  id: string
  name: string
  category: string
  provider: string
  status: string
  capabilities: unknown
  endpoint_domain: string | null
  endpoint_ip: string | null
  github_repo_owner: string | null
  github_repo_name: string | null
  github_workflow_file: string | null
  github_ref: string | null
  github_repository_id: string | null
  github_token: string | null
  notes: string | null
  registration_token: string | null
  registration_token_hash: string | null
  last_heartbeat_at: string | null
  last_seen_ip: string | null
  last_seen_host: string | null
  last_seen_version: string | null
  last_error: string | null
  metadata: unknown
  created_at: string
  updated_at: string
}

type DriveAgentRunRow = {
  id: string
  agent_id: string
  run_type: string
  status: string
  external_run_id: string | null
  job_reference: string | null
  summary: string | null
  payload: unknown
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

const AGENTS_TABLE = "drive_agents"
const AGENT_RUNS_TABLE = "drive_agent_runs"

function normalizeSupabaseError(error: { message: string }): Error {
  const message = String(error?.message ?? "Supabase error")
  if (message.includes("Could not find the table") && message.includes(AGENTS_TABLE)) {
    return new Error(
      `Supabase table '${AGENTS_TABLE}' is missing. Apply 'supabase/drive_schema.sql' before using agents/workers.`
    )
  }
  const lower = message.toLowerCase()
  if (lower.includes("<!doctype html") || lower.includes("<html")) {
    if (lower.includes("502") || lower.includes("bad gateway")) {
      return new Error("Supabase returned 502 Bad Gateway. This is a temporary upstream outage; retry in a few minutes.")
    }
    return new Error("Supabase returned an HTML error page instead of JSON. The backend is temporarily unavailable.")
  }
  return new Error(message)
}

function sanitizeCapabilities(value: unknown): AgentCapability[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => String(entry ?? ""))
    .filter((entry): entry is AgentCapability =>
      ["scan", "verify", "repair", "bulk_migrate", "diagnostics"].includes(entry)
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function mapAgentRow(row: DriveAgentRow): DriveAgent {
  return {
    id: row.id,
    name: row.name,
    category: (row.category === "agent" ? "agent" : "worker") as AgentCategory,
    provider: (["self_hosted", "github_actions", "local"].includes(row.provider) ? row.provider : "self_hosted") as AgentProvider,
    status: (
      ["pending_registration", "online", "offline", "busy", "dispatch_ready", "disabled", "error"].includes(row.status)
        ? row.status
        : "pending_registration"
    ) as AgentStatus,
    capabilities: sanitizeCapabilities(row.capabilities),
    endpointDomain: row.endpoint_domain ?? undefined,
    endpointIp: row.endpoint_ip ?? undefined,
    githubRepoOwner: row.github_repo_owner ?? undefined,
    githubRepoName: row.github_repo_name ?? undefined,
    githubWorkflowFile: row.github_workflow_file ?? undefined,
    githubRef: row.github_ref ?? undefined,
    githubRepositoryId: row.github_repository_id ?? undefined,
    notes: row.notes ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    lastSeenIp: row.last_seen_ip ?? undefined,
    lastSeenHost: row.last_seen_host ?? undefined,
    lastSeenVersion: row.last_seen_version ?? undefined,
    lastError: row.last_error ?? undefined,
    metadata: isRecord(row.metadata) ? row.metadata : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRunRow(row: DriveAgentRunRow): DriveAgentRun {
  return {
    id: row.id,
    agentId: row.agent_id,
    runType: row.run_type,
    status: (
      ["pending", "running", "completed", "failed", "canceled"].includes(row.status) ? row.status : "pending"
    ) as DriveAgentRun["status"],
    externalRunId: row.external_run_id ?? undefined,
    jobReference: row.job_reference ?? undefined,
    summary: row.summary ?? undefined,
    payload: isRecord(row.payload) ? row.payload : {},
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function hashRegistrationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

function buildRegistrationToken(): string {
  return `drvagt_${crypto.randomBytes(24).toString("hex")}`
}

function deriveInitialStatus(input: {
  provider: AgentProvider
  githubRepoOwner?: string
  githubRepoName?: string
  githubWorkflowFile?: string
}): AgentStatus {
  if (input.provider === "github_actions") {
    return input.githubRepoOwner && input.githubRepoName && input.githubWorkflowFile
      ? "dispatch_ready"
      : "error"
  }
  return "pending_registration"
}

export async function listAgents(): Promise<Array<DriveAgent & { latestRun: DriveAgentRun | null }>> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(AGENTS_TABLE).select("*").order("created_at", { ascending: false })
  if (error) throw normalizeSupabaseError(error)

  const agents = (Array.isArray(data) ? (data as DriveAgentRow[]) : []).map(mapAgentRow)
  if (agents.length === 0) return []

  const { data: runs, error: runsError } = await supabase
    .from(AGENT_RUNS_TABLE)
    .select("*")
    .in(
      "agent_id",
      agents.map((agent) => agent.id)
    )
    .order("created_at", { ascending: false })
  if (runsError) throw new Error(runsError.message)

  const latestByAgent = new Map<string, DriveAgentRun>()
  for (const run of Array.isArray(runs) ? (runs as DriveAgentRunRow[]) : []) {
    if (latestByAgent.has(run.agent_id)) continue
    latestByAgent.set(run.agent_id, mapRunRow(run))
  }

  return agents.map((agent) => ({
    ...agent,
    latestRun: latestByAgent.get(agent.id) ?? null,
  }))
}

export async function createAgent(input: {
  name: string
  category: AgentCategory
  provider: AgentProvider
  capabilities: AgentCapability[]
  endpointDomain?: string
  endpointIp?: string
  githubRepoOwner?: string
  githubRepoName?: string
  githubWorkflowFile?: string
  githubRef?: string
  githubRepositoryId?: string
  githubToken?: string
  notes?: string
}): Promise<{ agent: DriveAgent; registrationToken?: string }> {
  const supabase = getSupabaseServerClient()
  const name = input.name.trim()
  if (!name) throw new Error("Agent/worker name is required")

  const registrationToken = buildRegistrationToken()

  const row = {
    id: crypto.randomUUID(),
    name,
    category: input.category,
    provider: input.provider,
    status: deriveInitialStatus(input),
    capabilities: Array.from(new Set(input.capabilities)),
    endpoint_domain: input.endpointDomain?.trim() || null,
    endpoint_ip: input.endpointIp?.trim() || null,
    github_repo_owner: input.githubRepoOwner?.trim() || null,
    github_repo_name: input.githubRepoName?.trim() || null,
    github_workflow_file: input.githubWorkflowFile?.trim() || null,
    github_ref: input.githubRef?.trim() || null,
    github_repository_id: input.githubRepositoryId?.trim() || null,
    github_token: input.githubToken?.trim() || null,
    notes: input.notes?.trim() || null,
    registration_token: registrationToken ?? null,
    registration_token_hash: registrationToken ? hashRegistrationToken(registrationToken) : null,
    metadata: {},
  }

  const { data, error } = await supabase.from(AGENTS_TABLE).insert(row).select("*").single()
  if (error) throw normalizeSupabaseError(error)

  return { agent: mapAgentRow(data as DriveAgentRow), ...(registrationToken ? { registrationToken } : {}) }
}

export async function getAgentById(id: string): Promise<DriveAgent | null> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(AGENTS_TABLE).select("*").eq("id", id).limit(1)
  if (error) throw normalizeSupabaseError(error)
  const row = Array.isArray(data) ? (data[0] as DriveAgentRow | undefined) : undefined
  return row ? mapAgentRow(row) : null
}

export async function getAgentGithubToken(agentId: string): Promise<string | null> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(AGENTS_TABLE).select("github_token").eq("id", agentId).limit(1)
  if (error) throw normalizeSupabaseError(error)
  const row = Array.isArray(data) ? (data[0] as { github_token?: string | null } | undefined) : undefined
  return typeof row?.github_token === "string" && row.github_token.trim() ? row.github_token.trim() : null
}

export async function getAgentRegistrationToken(agentId: string): Promise<string | null> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(AGENTS_TABLE).select("registration_token").eq("id", agentId).limit(1)
  if (error) throw normalizeSupabaseError(error)
  const row = Array.isArray(data) ? (data[0] as { registration_token?: string | null } | undefined) : undefined
  return typeof row?.registration_token === "string" && row.registration_token.trim() ? row.registration_token.trim() : null
}

export async function ensureAgentRegistrationToken(agentId: string): Promise<string> {
  const existing = await getAgentRegistrationToken(agentId)
  if (existing) return existing

  const supabase = getSupabaseServerClient()
  const registrationToken = buildRegistrationToken()
  const { data, error } = await supabase
    .from(AGENTS_TABLE)
    .update({
      registration_token: registrationToken,
      registration_token_hash: hashRegistrationToken(registrationToken),
      updated_at: new Date().toISOString(),
    })
    .eq("id", agentId)
    .select("registration_token")
    .single()
  if (error) throw normalizeSupabaseError(error)

  const token =
    isRecord(data) && typeof data.registration_token === "string" && data.registration_token.trim()
      ? data.registration_token.trim()
      : registrationToken

  return token
}

export async function createAgentRun(input: {
  agentId: string
  runType: string
  status?: DriveAgentRun["status"]
  externalRunId?: string
  jobReference?: string
  summary?: string
  payload?: Record<string, unknown>
}): Promise<DriveAgentRun> {
  const supabase = getSupabaseServerClient()
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from(AGENT_RUNS_TABLE)
    .insert({
      id: crypto.randomUUID(),
      agent_id: input.agentId,
      run_type: input.runType,
      status: input.status ?? "pending",
      external_run_id: input.externalRunId ?? null,
      job_reference: input.jobReference ?? null,
      summary: input.summary ?? null,
      payload: input.payload ?? {},
      started_at: input.status === "running" ? now : null,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single()
  if (error) throw normalizeSupabaseError(error)
  return mapRunRow(data as DriveAgentRunRow)
}

export async function updateAgentRun(
  id: string,
  updates: Partial<{
    status: DriveAgentRun["status"]
    externalRunId: string | null
    summary: string | null
    payload: Record<string, unknown>
    completedAt: string | null
  }>
): Promise<DriveAgentRun> {
  const supabase = getSupabaseServerClient()
  const now = new Date().toISOString()
  const dbUpdates: Record<string, unknown> = { updated_at: now }
  if (updates.status !== undefined) dbUpdates.status = updates.status
  if (updates.externalRunId !== undefined) dbUpdates.external_run_id = updates.externalRunId ?? null
  if (updates.summary !== undefined) dbUpdates.summary = updates.summary ?? null
  if (updates.payload !== undefined) dbUpdates.payload = updates.payload
  if (updates.completedAt !== undefined) dbUpdates.completed_at = updates.completedAt ?? null
  const { data, error } = await supabase.from(AGENT_RUNS_TABLE).update(dbUpdates).eq("id", id).select("*").single()
  if (error) throw normalizeSupabaseError(error)
  return mapRunRow(data as DriveAgentRunRow)
}

export async function authenticateAgent(input: { agentId: string; token: string }): Promise<DriveAgent> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(AGENTS_TABLE).select("*").eq("id", input.agentId).limit(1)
  if (error) throw normalizeSupabaseError(error)
  const row = Array.isArray(data) ? (data[0] as DriveAgentRow | undefined) : undefined
  if (!row) throw new Error("Agent/worker not found")
  if (!row.registration_token_hash) throw new Error("This agent/worker does not use token authentication")
  if (hashRegistrationToken(input.token) !== row.registration_token_hash) throw new Error("Invalid registration token")
  return mapAgentRow(row)
}

export async function deleteAgent(id: string): Promise<void> {
  const supabase = getSupabaseServerClient()
  const { error } = await supabase.from(AGENTS_TABLE).delete().eq("id", id)
  if (error) throw normalizeSupabaseError(error)
}

export async function recordAgentHeartbeat(input: {
  agentId: string
  token: string
  remoteIp?: string | null
  host?: string | null
  version?: string | null
  capabilities?: AgentCapability[]
  metadata?: Record<string, unknown>
}): Promise<DriveAgent> {
  const supabase = getSupabaseServerClient()
  const authenticated = await authenticateAgent({ agentId: input.agentId, token: input.token })
  const { data, error } = await supabase.from(AGENTS_TABLE).select("*").eq("id", input.agentId).limit(1)
  if (error) throw normalizeSupabaseError(error)
  const row = Array.isArray(data) ? (data[0] as DriveAgentRow | undefined) : undefined
  if (!row) throw new Error("Agent/worker not found")

  const now = new Date().toISOString()
  const nextCapabilities =
    input.capabilities && input.capabilities.length > 0 ? Array.from(new Set(input.capabilities)) : authenticated.capabilities
  const nextStatus: AgentStatus = row.status === "disabled" ? "disabled" : "online"

  const { data: updated, error: updateError } = await supabase
    .from(AGENTS_TABLE)
    .update({
      status: nextStatus,
      last_heartbeat_at: now,
      last_seen_ip: input.remoteIp ?? row.last_seen_ip,
      last_seen_host: input.host ?? row.last_seen_host,
      last_seen_version: input.version ?? row.last_seen_version,
      capabilities: nextCapabilities,
      metadata: input.metadata ?? row.metadata ?? {},
      updated_at: now,
      last_error: null,
    })
    .eq("id", input.agentId)
    .select("*")
    .single()

  if (updateError) throw new Error(updateError.message)
  return mapAgentRow(updated as DriveAgentRow)
}
