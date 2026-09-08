import crypto from "crypto"
import {
  getAgentGithubToken,
  listAgents,
  updateAgent,
  updateAgentRun,
} from "./agents-store"
import { cancelGitHubWorkflowRun, forceCancelGitHubWorkflowRun, getGitHubWorkflowRun, listGitHubWorkflowRunJobs, listGitHubWorkflowRuns } from "./github-oauth"
import { getSupabaseServerClient } from "./supabase"
import { getMigration, listMigrationItems, updateMigration, updateMigrationItem, type DriveMigrationItem } from "./migrations-store"
import { getAllAccounts } from "./accounts-store"

export type RepairJobStatus = "pending" | "claimed" | "running" | "completed" | "failed" | "canceled"
export type RepairJobMode = "verify_only" | "repair_only" | "repair_and_verify"

export type DriveRepairJob = {
  id: string
  migrationId: string
  workKey?: string
  requestedByAgentId?: string
  claimedByAgentId?: string
  status: RepairJobStatus
  mode: RepairJobMode
  payload: Record<string, unknown>
  progress: Record<string, unknown>
  result: Record<string, unknown>
  summary?: string
  error?: string
  claimedAt?: string
  startedAt?: string
  completedAt?: string
  lastHeartbeatAt?: string
  createdAt: string
  updatedAt: string
}

type DriveRepairJobRow = {
  id: string
  migration_id: string
  work_key: string | null
  requested_by_agent_id: string | null
  claimed_by_agent_id: string | null
  status: string
  mode: string
  payload: Record<string, unknown> | null
  progress: Record<string, unknown> | null
  result: Record<string, unknown> | null
  summary: string | null
  error: string | null
  claimed_at: string | null
  started_at: string | null
  completed_at: string | null
  last_heartbeat_at: string | null
  created_at: string
  updated_at: string
}

const REPAIR_JOBS_TABLE = "drive_repair_jobs"
const DEFAULT_WORKER_SHARD_COUNT = 32
const MAX_WORKER_SHARD_COUNT = 128
const MAX_WORKER_REQUEUE_ATTEMPTS = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseWorkerShardWorkKey(value: unknown): {
  migrationId: string
  generation: number
  index: number
  count: number
} | null {
  if (typeof value !== "string") return null
  const match = value.match(/^migration:([^:]+):generation:(\d+):shard:(\d+)\/(\d+)$/)
  if (!match) return null
  const generation = Number(match[2])
  const index = Number(match[3])
  const count = Number(match[4])
  if (
    !match[1] ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_WORKER_SHARD_COUNT ||
    index < 0 ||
    index >= count
  ) {
    return null
  }
  return { migrationId: match[1], generation, index, count }
}

function workerGenerationAndShardCount(migration: { options?: Record<string, unknown> } | null | undefined) {
  const generation =
    typeof migration?.options?.workerGeneration === "number" && Number.isFinite(migration.options.workerGeneration)
      ? Math.max(1, Math.floor(migration.options.workerGeneration))
      : 1
  const shardCount =
    typeof migration?.options?.workerShardCount === "number" && Number.isFinite(migration.options.workerShardCount)
      ? Math.max(1, Math.min(MAX_WORKER_SHARD_COUNT, Math.floor(migration.options.workerShardCount)))
      : DEFAULT_WORKER_SHARD_COUNT
  return { generation, shardCount }
}

function mapJobRow(row: DriveRepairJobRow): DriveRepairJob {
  return {
    id: row.id,
    migrationId: row.migration_id,
    workKey: row.work_key ?? undefined,
    requestedByAgentId: row.requested_by_agent_id ?? undefined,
    claimedByAgentId: row.claimed_by_agent_id ?? undefined,
    status: (["pending", "claimed", "running", "completed", "failed", "canceled"].includes(row.status)
      ? row.status
      : "pending") as RepairJobStatus,
    mode: (["verify_only", "repair_only", "repair_and_verify"].includes(row.mode) ? row.mode : "repair_and_verify") as RepairJobMode,
    payload: isRecord(row.payload) ? row.payload : {},
    progress: isRecord(row.progress) ? row.progress : {},
    result: isRecord(row.result) ? row.result : {},
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeSupabaseError(error: { message: string }): Error {
  const message = String(error?.message ?? "Supabase error")
  if (message.includes("Could not find the table") && message.includes(REPAIR_JOBS_TABLE)) {
    return new Error(
      `Supabase table '${REPAIR_JOBS_TABLE}' is missing. Apply 'supabase/drive_schema.sql' before using worker jobs.`
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

function wrapSupabaseQueryError(error: unknown, context: string): Error {
  if (error instanceof SyntaxError) {
    return new Error(
      `Supabase returned invalid or empty JSON while ${context}. This usually means the upstream response was truncated or an HTML/error page was returned instead of JSON.`
    )
  }
  if (error && typeof error === "object" && "message" in error) {
    return normalizeSupabaseError(error as { message: string })
  }
  return error instanceof Error ? error : new Error(`${context} failed`)
}

async function syncMigrationStatusFromLiveState(migrationId: string): Promise<void> {
  const { syncMigrationLiveState } = await import("./migration-live-state")
  await syncMigrationLiveState(migrationId)
}

function getGitHubTokenFallback(): string {
  return (
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  ).trim()
}

function isRecentIso(value: string | undefined, maxAgeMs: number): boolean {
  if (!value) return false
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return false
  return Date.now() - time <= maxAgeMs
}

function isPastRepairJobGraceWindow(job: {
  createdAt?: string
  claimedAt?: string
  startedAt?: string
  lastHeartbeatAt?: string
}): boolean {
  const anchors = [job.lastHeartbeatAt, job.startedAt, job.claimedAt, job.createdAt]
    .map((value) => (typeof value === "string" ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value))

  if (anchors.length === 0) return true
  const latestAnchor = Math.max(...anchors)
  return Date.now() - latestAnchor > 180_000
}

function buildGitHubRunDiagnostics(
  jobs: Array<{
    name?: string
    status?: string
    conclusion?: string | null
    steps: Array<{ name?: string; status?: string; conclusion?: string | null }>
  }>
) {
  const lines: string[] = []
  const failureBits: string[] = []

  for (const job of jobs) {
    if (job.name) {
      lines.push(`${job.name}: ${job.status || "unknown"}${job.conclusion ? ` (${job.conclusion})` : ""}`)
    }

    for (const step of job.steps) {
      if (!step.name) continue
      if (lines.length < 12) {
        lines.push(`- ${step.name}: ${step.status || "unknown"}${step.conclusion ? ` (${step.conclusion})` : ""}`)
      }
      if (step.conclusion && step.conclusion !== "success" && step.conclusion !== "skipped" && failureBits.length < 4) {
        failureBits.push(`${job.name || "job"} / ${step.name}: ${step.conclusion}`)
      }
    }
  }

  return {
    githubLogLines: lines,
    failureReason: failureBits[0] ?? null,
  }
}

function matchGithubRunToDispatch(
  runs: Awaited<ReturnType<typeof listGitHubWorkflowRuns>>,
  dispatchRequestedAt: unknown,
  excludedRunIds: unknown,
  identityHints: string[] = []
) {
  if (!Array.isArray(runs) || runs.length === 0) return null

  const requestedAt =
    typeof dispatchRequestedAt === "string" && dispatchRequestedAt.trim().length > 0 ? Date.parse(dispatchRequestedAt) : Number.NaN

  if (!Number.isFinite(requestedAt)) return null
  const excluded = new Set(Array.isArray(excludedRunIds) ? excludedRunIds.filter((value): value is string => typeof value === "string") : [])

  const candidates = runs.filter((candidate) => {
      if (excluded.has(candidate.id)) return false
      const createdAt = Date.parse(candidate.createdAt || "")
      if (!Number.isFinite(createdAt)) return false
      return createdAt >= requestedAt - 10_000
    })
  if (candidates.length === 0) return null
  const hints = identityHints.filter((value) => typeof value === "string" && value.length > 0)
  const identified = hints.length > 0
    ? candidates.filter((candidate) => {
        const identity = `${candidate.displayTitle ?? ""} ${candidate.name ?? ""}`
        return hints.some((hint) => identity.includes(hint))
      })
    : []
  if (identified.length === 1) return identified[0]
  // If GitHub has not indexed the new run-name format yet, only accept an
  // unambiguous timestamp match. Never bind one worker to another worker's
  // run when several dispatches share a repository.
  return candidates.length === 1 ? candidates[0] : null
}

async function getRepairJobRaw(id: string): Promise<DriveRepairJob | null> {
  const supabase = getSupabaseServerClient()
  let data: unknown
  let error: { message: string } | null = null
  try {
    const response = await supabase.from(REPAIR_JOBS_TABLE).select("*").eq("id", id).limit(1)
    data = response.data
    error = response.error
  } catch (caughtError) {
    throw wrapSupabaseQueryError(caughtError, `reading '${REPAIR_JOBS_TABLE}' by id`)
  }
  if (error) throw normalizeSupabaseError(error)
  const row = Array.isArray(data) ? (data[0] as DriveRepairJobRow | undefined) : undefined
  return row ? mapJobRow(row) : null
}

let repairJobReconcilePromise: Promise<void> | null = null

export async function reconcileRepairJobs(input?: { jobId?: string; migrationId?: string }): Promise<void> {
  if (repairJobReconcilePromise) {
    await repairJobReconcilePromise.catch(() => undefined)
    return
  }

  repairJobReconcilePromise = (async () => {
    const agents = await listAgents()

    for (const agent of agents) {
      if (agent.provider !== "github_actions" || !agent.latestRun || agent.latestRun.runType !== "github_dispatch") continue
      if (!agent.githubRepoOwner || !agent.githubRepoName || !agent.githubWorkflowFile) continue

      const latestRun = agent.latestRun
      if (input?.jobId && latestRun.jobReference !== input.jobId) continue

      const githubToken = (await getAgentGithubToken(agent.id).catch(() => null)) || getGitHubTokenFallback()
      if (!githubToken) continue

      const linkedRepairJob = latestRun.jobReference ? await getRepairJobRaw(latestRun.jobReference).catch(() => null) : null
      if (input?.migrationId && linkedRepairJob?.migrationId !== input.migrationId) continue

      const activeRepairJob =
        linkedRepairJob && (linkedRepairJob.status === "pending" || linkedRepairJob.status === "claimed" || linkedRepairJob.status === "running")
      const hasFreshWorkerHeartbeat = isRecentIso(linkedRepairJob?.lastHeartbeatAt || agent.lastHeartbeatAt, 90_000)
      const reconcileAllowed = linkedRepairJob ? isPastRepairJobGraceWindow(linkedRepairJob) : true

      let githubRun: Awaited<ReturnType<typeof getGitHubWorkflowRun>> | null = null
      if (latestRun.externalRunId) {
        githubRun = await getGitHubWorkflowRun({
          token: githubToken,
          owner: agent.githubRepoOwner,
          repo: agent.githubRepoName,
          runId: latestRun.externalRunId,
        }).catch(() => null)
      } else {
        const runs = await listGitHubWorkflowRuns({
          token: githubToken,
          owner: agent.githubRepoOwner,
          repo: agent.githubRepoName,
          workflow: agent.githubWorkflowFile,
          branch: agent.githubRef || "main",
          event: "workflow_dispatch",
          perPage: 10,
        }).catch(() => [])
        githubRun = matchGithubRunToDispatch(
          runs,
          (latestRun.payload ?? {}).dispatchRequestedAt,
          (latestRun.payload ?? {}).githubRunIdsBeforeDispatch,
          [agent.id, latestRun.jobReference ?? ""]
        )
      }

      if (!githubRun) {
        continue
      }

      const currentStatus = String(githubRun.status ?? "").toLowerCase()
      const conclusion = String(githubRun.conclusion ?? "").toLowerCase()
      const githubJobs =
        latestRun.externalRunId || githubRun.id
          ? await listGitHubWorkflowRunJobs({
              token: githubToken,
              owner: agent.githubRepoOwner,
              repo: agent.githubRepoName,
              runId: latestRun.externalRunId ?? githubRun.id,
            }).catch(() => [])
          : []
      const diagnostics = buildGitHubRunDiagnostics(githubJobs)
      const abortRequested =
        Boolean((latestRun.payload ?? {}).githubAbortRequestedAt) || linkedRepairJob?.status === "canceled"

      const runStatus =
        hasFreshWorkerHeartbeat && activeRepairJob
          ? "running"
          : abortRequested && currentStatus === "completed"
            ? "canceled"
            : currentStatus === "completed"
              ? conclusion === "success"
                ? "completed"
                : conclusion === "cancelled"
                  ? "canceled"
                  : "failed"
              : "running"

      await updateAgentRun(latestRun.id, {
        status: runStatus,
        externalRunId: githubRun.id,
        summary:
          runStatus === "completed"
            ? "GitHub workflow completed successfully"
            : runStatus === "canceled"
              ? abortRequested
                ? "GitHub workflow was aborted by user"
                : "GitHub workflow was aborted"
              : runStatus === "failed"
                ? `GitHub workflow failed${conclusion ? ` (${conclusion})` : ""}`
                : "GitHub workflow is running",
        payload: {
          ...(latestRun.payload ?? {}),
          ...(githubRun.htmlUrl ? { htmlUrl: githubRun.htmlUrl } : {}),
          githubStatus: currentStatus || null,
          githubConclusion: conclusion || null,
          githubUpdatedAt: githubRun.updatedAt ?? null,
          ...(githubJobs.length > 0 ? { githubJobs } : {}),
          ...(diagnostics.githubLogLines.length > 0 ? { githubLogLines: diagnostics.githubLogLines } : {}),
          ...(diagnostics.failureReason ? { failureReason: diagnostics.failureReason } : {}),
        },
        ...(runStatus === "completed" || runStatus === "failed" || runStatus === "canceled"
          ? { completedAt: new Date().toISOString() }
          : {}),
      }).catch(() => undefined)

      await updateAgent(agent.id, {
        status: runStatus === "running" ? "online" : "offline",
        lastError:
          runStatus === "failed" ? diagnostics.failureReason || `GitHub workflow failed${conclusion ? ` (${conclusion})` : ""}` : null,
        metadata: {
          ...(agent.metadata ?? {}),
          activeRepairJobId: runStatus === "running" ? latestRun.jobReference ?? null : null,
          githubRunStatus: currentStatus || null,
          githubRunConclusion: conclusion || null,
          githubRunUpdatedAt: githubRun.updatedAt ?? null,
          ...(githubRun.htmlUrl ? { githubRunUrl: githubRun.htmlUrl } : {}),
        },
      }).catch(() => undefined)

      if (reconcileAllowed && !hasFreshWorkerHeartbeat && (runStatus === "failed" || runStatus === "canceled") && latestRun.jobReference) {
        const repairJob = linkedRepairJob ?? (await getRepairJobRaw(latestRun.jobReference).catch(() => null))
        if (repairJob && (repairJob.status === "pending" || repairJob.status === "claimed" || repairJob.status === "running")) {
          if (currentStatus !== "completed") {
            await cancelGitHubWorkflowRun({
              token: githubToken,
              owner: agent.githubRepoOwner,
              repo: agent.githubRepoName,
              runId: latestRun.externalRunId ?? githubRun.id,
            }).catch(() => undefined)
            await forceCancelGitHubWorkflowRun({
              token: githubToken,
              owner: agent.githubRepoOwner,
              repo: agent.githubRepoName,
              runId: latestRun.externalRunId ?? githubRun.id,
            }).catch(() => undefined)
          }

          const terminalStatus = runStatus === "canceled" ? "canceled" : "failed"
          const terminalSummary =
            runStatus === "canceled"
              ? abortRequested
                ? "GitHub workflow was aborted by user before worker completed the job"
                : "GitHub workflow was aborted before worker completed the job"
              : diagnostics.failureReason || `GitHub workflow failed${conclusion ? ` (${conclusion})` : ""}`
          const terminalError =
            runStatus === "failed" ? diagnostics.failureReason || `GitHub workflow failed${conclusion ? ` (${conclusion})` : ""}` : "GitHub workflow was aborted"
          const now = new Date().toISOString()

          await updateRepairJob(repairJob.id, {
            status: terminalStatus,
            summary: terminalSummary,
            error: terminalError,
            result: {
              ...(repairJob.result ?? {}),
              githubRun: {
                id: githubRun.id,
                htmlUrl: githubRun.htmlUrl ?? null,
                status: currentStatus || null,
                conclusion: conclusion || null,
                updatedAt: githubRun.updatedAt ?? null,
                jobs: githubJobs,
                logLines: diagnostics.githubLogLines,
              },
            },
            completedAt: now,
            lastHeartbeatAt: now,
          }).catch(() => undefined)

          await updateMigration(repairJob.migrationId, {
            ...(terminalStatus === "failed" ? { syncStatus: "error" as const } : { syncStatus: "ok" as const }),
            syncMessage: terminalSummary,
            lastSyncedAt: now,
          }).catch(() => undefined)

          await syncMigrationStatusFromLiveState(repairJob.migrationId).catch(() => undefined)
        }
      }
    }

    const refreshedAgents = await listAgents()
    const activeAgentById = new Map(refreshedAgents.map((agent) => [agent.id, agent]))
    // A worker migration can have up to MAX_WORKER_SHARD_COUNT active shard
    // records. Reconcile the full bounded queue so a larger pool is never
    // partially treated as healthy simply because the newest 100 rows were
    // selected.
    const activeJobs = await listRepairJobsRaw(500)

    for (const job of activeJobs) {
      if (!job.claimedByAgentId) continue
      if (!["pending", "claimed", "running"].includes(job.status)) continue

      const agent = activeAgentById.get(job.claimedByAgentId)
      if (!agent) continue
      if (input?.jobId && job.id !== input.jobId) continue
      if (input?.migrationId && job.migrationId !== input.migrationId) continue

      if (agent.provider === "self_hosted" || agent.provider === "local") {
        const workerOnline =
          isRecentIso(job.lastHeartbeatAt, 90_000) ||
          (agent.status === "online" && isRecentIso(agent.lastHeartbeatAt, 60_000))
        if (!workerOnline && isPastRepairJobGraceWindow(job)) {
          const now = new Date().toISOString()
          await updateRepairJob(job.id, {
            status: "failed",
            summary: "Self-hosted worker went offline before the job completed",
            error: "Self-hosted worker is offline. Start the worker and run the job again.",
            completedAt: now,
            lastHeartbeatAt: now,
          }).catch(() => undefined)

          await updateMigration(job.migrationId, {
            syncStatus: "error",
            syncMessage: "Self-hosted worker went offline before the job completed",
            lastSyncedAt: now,
          }).catch(() => undefined)

          await syncMigrationStatusFromLiveState(job.migrationId).catch(() => undefined)

          await updateAgent(agent.id, {
            status: "offline",
            lastError: null,
            metadata: {
              ...(agent.metadata ?? {}),
              activeRepairJobId: null,
            },
          }).catch(() => undefined)
        }
      }
    }
  })()

  try {
    await repairJobReconcilePromise
  } finally {
    repairJobReconcilePromise = null
  }
}

async function listRepairJobsRaw(limit = 50): Promise<DriveRepairJob[]> {
  const supabase = getSupabaseServerClient()
  let data: unknown
  let error: { message: string } | null = null
  try {
    const response = await supabase.from(REPAIR_JOBS_TABLE).select("*").order("created_at", { ascending: false }).limit(limit)
    data = response.data
    error = response.error
  } catch (caughtError) {
    throw wrapSupabaseQueryError(caughtError, `reading '${REPAIR_JOBS_TABLE}'`)
  }
  if (error) throw normalizeSupabaseError(error)
  return (Array.isArray(data) ? (data as DriveRepairJobRow[]) : []).map(mapJobRow)
}

async function listRepairJobsByMigrationRaw(migrationId: string, limit = 20): Promise<DriveRepairJob[]> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(REPAIR_JOBS_TABLE)
    .select("*")
    .eq("migration_id", migrationId)
    .order("created_at", { ascending: false })
    .limit(limit)
  if (error) throw normalizeSupabaseError(error)
  return (Array.isArray(data) ? (data as DriveRepairJobRow[]) : []).map(mapJobRow)
}

async function listWorkerShardJobsByMigrationRaw(
  migrationId: string,
  generation: number,
  limit = MAX_WORKER_SHARD_COUNT
): Promise<DriveRepairJob[]> {
  const supabase = getSupabaseServerClient()
  const prefix = `migration:${migrationId}:generation:${generation}:shard:`
  const { data, error } = await supabase
    .from(REPAIR_JOBS_TABLE)
    .select("*")
    .eq("migration_id", migrationId)
    .like("work_key", `${prefix}%`)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(MAX_WORKER_SHARD_COUNT, limit)))
  if (error) throw normalizeSupabaseError(error)
  return (Array.isArray(data) ? (data as DriveRepairJobRow[]) : []).map(mapJobRow)
}

export async function listRepairJobs(limit = 50): Promise<DriveRepairJob[]> {
  await reconcileRepairJobs().catch(() => undefined)
  return listRepairJobsRaw(limit)
}

export async function listRepairJobsByMigration(migrationId: string, limit = 20): Promise<DriveRepairJob[]> {
  await reconcileRepairJobs({ migrationId }).catch(() => undefined)
  return listRepairJobsByMigrationRaw(migrationId, limit)
}

export async function findActiveRepairJobForDispatch(input: {
  migrationId: string
  requestedByAgentId?: string
}): Promise<DriveRepairJob | null> {
  const supabase = getSupabaseServerClient()
  let query = supabase
    .from(REPAIR_JOBS_TABLE)
    .select("*")
    .eq("migration_id", input.migrationId)
    .in("status", ["pending", "claimed", "running"])
    .order("created_at", { ascending: false })
    .limit(10)

  if (input.requestedByAgentId) {
    query = query.eq("requested_by_agent_id", input.requestedByAgentId)
  }

  const { data, error } = await query
  if (error) throw normalizeSupabaseError(error)
  const rows = Array.isArray(data) ? (data as DriveRepairJobRow[]) : []
  return rows.length > 0 ? mapJobRow(rows[0]) : null
}

export async function createRepairJob(input: {
  migrationId: string
  mode?: RepairJobMode
  requestedByAgentId?: string
  payload?: Record<string, unknown>
  workKey?: string
}): Promise<DriveRepairJob> {
  const migration = await getMigration(input.migrationId)
  if (!migration) throw new Error("Migration not found")

  const supabase = getSupabaseServerClient()
  const row = {
    id: crypto.randomUUID(),
    migration_id: input.migrationId,
    work_key: input.workKey?.trim() || null,
    requested_by_agent_id: input.requestedByAgentId ?? null,
    status: "pending",
    mode: input.mode ?? "repair_and_verify",
    payload: input.payload ?? {},
    progress: {},
    result: {},
  }

  const { data, error } = await supabase.from(REPAIR_JOBS_TABLE).insert(row).select("*").single()
  if (error) {
    // Shard jobs are idempotent. Concurrent orchestrator ticks can race here;
    // the unique work_key index makes one row win and the loser reuses it.
    if (input.workKey && /duplicate|unique constraint|already exists/i.test(String(error.message ?? ""))) {
      const existing = await supabase
        .from(REPAIR_JOBS_TABLE)
        .select("*")
        .eq("work_key", input.workKey.trim())
        .limit(1)
      if (!existing.error && Array.isArray(existing.data) && existing.data[0]) {
        return mapJobRow(existing.data[0] as DriveRepairJobRow)
      }
    }
    throw normalizeSupabaseError(error)
  }

  await updateMigration(input.migrationId, {
    syncStatus: "ok",
    syncMessage: "Queued recovery/verification worker job",
    lastSyncedAt: new Date().toISOString(),
  }).catch(() => undefined)

  return mapJobRow(data as DriveRepairJobRow)
}

export async function claimRepairJob(
  agentId: string,
  requestedJobId?: string,
  migrationId?: string,
  poolOnly = false
): Promise<DriveRepairJob | null> {
  const supabase = getSupabaseServerClient()
  const poolMigration = poolOnly && migrationId ? await getMigration(migrationId) : null
  if (
    poolOnly &&
    (!poolMigration ||
      poolMigration.options.executionMode !== "migration_workers" ||
      !["running", "verifying"].includes(poolMigration.status))
  ) return null
  const poolCoordinates = poolMigration ? workerGenerationAndShardCount(poolMigration) : null
  let pendingQuery = supabase
    .from(REPAIR_JOBS_TABLE)
    .select("*")
    .eq("status", "pending")
    .or(`requested_by_agent_id.is.null,requested_by_agent_id.eq.${agentId}`)
    .order("created_at", { ascending: true })
    // A pool worker may only claim durable shard records. Without this filter
    // an older/manual repair row in the same migration could be claimed first
    // and make the worker process the whole migration again.
    .limit(poolOnly ? 100 : 1)
  if (requestedJobId) pendingQuery = pendingQuery.eq("id", requestedJobId)
  if (migrationId) pendingQuery = pendingQuery.eq("migration_id", migrationId)
  if (poolOnly && migrationId && poolCoordinates) {
    pendingQuery = pendingQuery.like(
      "work_key",
      `migration:${migrationId}:generation:${poolCoordinates.generation}:shard:%`
    )
  }
  const { data: pendingRows, error: listError } = await pendingQuery
  if (listError) throw normalizeSupabaseError(listError)
  const candidate = Array.isArray(pendingRows)
    ? ((pendingRows.find((row) => {
        if (!poolOnly) return true
        const key = parseWorkerShardWorkKey(typeof row === "object" && row !== null ? (row as DriveRepairJobRow).work_key : null)
        return Boolean(
          key &&
            key.migrationId === migrationId &&
            key.generation === poolCoordinates?.generation &&
            key.count === poolCoordinates?.shardCount
        )
      }) ?? undefined) as DriveRepairJobRow | undefined)
    : undefined
  if (!candidate) return null

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from(REPAIR_JOBS_TABLE)
    .update({
      status: "claimed",
      claimed_by_agent_id: agentId,
      claimed_at: now,
      started_at: now,
      last_heartbeat_at: now,
      updated_at: now,
    })
    .eq("id", candidate.id)
    .eq("status", "pending")
    .select("*")
    .single()
  if (error) return null
  return mapJobRow(data as DriveRepairJobRow)
}

export async function getRepairJob(id: string): Promise<DriveRepairJob | null> {
  await reconcileRepairJobs({ jobId: id }).catch(() => undefined)
  return getRepairJobRaw(id)
}

export async function deleteRepairJob(id: string): Promise<void> {
  const supabase = getSupabaseServerClient()
  const { error } = await supabase.from(REPAIR_JOBS_TABLE).delete().eq("id", id)
  if (error) throw normalizeSupabaseError(error)
}

export async function abortRepairJob(id: string): Promise<DriveRepairJob> {
  const existing = await getRepairJob(id)
  if (!existing) throw new Error("Repair job not found")
  if (existing.status === "completed" || existing.status === "failed") {
    return existing
  }

  const now = new Date().toISOString()
  const updated = await updateRepairJob(id, {
    status: "canceled",
    summary: "Worker job aborted by user",
    error: null,
    completedAt: now,
    lastHeartbeatAt: now,
  })

  const items = await listMigrationItems(existing.migrationId)
  await Promise.all(
    items.map(async (item) => {
      const progress = isRecord(item.progress) ? item.progress : {}
      const repair = isRecord(progress.repairWorker) ? progress.repairWorker : null
      const live = isRecord(progress.live) ? progress.live : null
      const repairJobId = typeof repair?.jobId === "string" ? repair.jobId : null
      const liveRepairJobId = typeof live?.repairJobId === "string" ? live.repairJobId : null
      const repairStatus = typeof repair?.status === "string" ? repair.status : ""
      if (!["pending", "claimed", "running"].includes(repairStatus)) return
      if (repairJobId && repairJobId !== id && liveRepairJobId !== id) return

      await applyRepairJobItemUpdate({
        migrationId: existing.migrationId,
        itemId: item.id,
        repairJobId: id,
        stage: typeof repair?.stage === "string" ? repair.stage : "repair_aborted",
        status: "canceled",
        summary: "Worker job aborted by user",
      })
    })
  )

  await updateMigration(existing.migrationId, {
    syncStatus: "ok",
    syncMessage: "Worker reconciliation aborted",
    lastSyncedAt: now,
  }).catch(() => undefined)

  await syncMigrationStatusFromLiveState(existing.migrationId).catch(() => undefined)

  return updated
}

export async function updateRepairJob(
  id: string,
  updates: {
    status?: RepairJobStatus
    progress?: Record<string, unknown>
    result?: Record<string, unknown>
    summary?: string | null
    error?: string | null
    claimedByAgentId?: string | null
    /** Require the current active lease to still belong to this agent. */
    expectedAgentId?: string
    startedAt?: string | null
    completedAt?: string | null
    lastHeartbeatAt?: string | null
  }
): Promise<DriveRepairJob> {
  const supabase = getSupabaseServerClient()
  const dbUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (updates.status !== undefined) dbUpdates.status = updates.status
  if (updates.progress !== undefined) dbUpdates.progress = updates.progress
  if (updates.result !== undefined) dbUpdates.result = updates.result
  if (updates.summary !== undefined) dbUpdates.summary = updates.summary ?? null
  if (updates.error !== undefined) dbUpdates.error = updates.error ?? null
  if (updates.claimedByAgentId !== undefined) dbUpdates.claimed_by_agent_id = updates.claimedByAgentId ?? null
  if (updates.startedAt !== undefined) dbUpdates.started_at = updates.startedAt ?? null
  if (updates.completedAt !== undefined) dbUpdates.completed_at = updates.completedAt ?? null
  if (updates.lastHeartbeatAt !== undefined) dbUpdates.last_heartbeat_at = updates.lastHeartbeatAt ?? null

  let query = supabase.from(REPAIR_JOBS_TABLE).update(dbUpdates).eq("id", id)
  if (updates.expectedAgentId) {
    query = query.eq("claimed_by_agent_id", updates.expectedAgentId).in("status", ["claimed", "running"])
  }
  const { data, error } = await query.select("*")
  if (error) throw normalizeSupabaseError(error)
  const row = Array.isArray(data) ? (data[0] as DriveRepairJobRow | undefined) : undefined
  if (!row) {
    if (updates.expectedAgentId) throw new Error("This job is no longer owned by this worker")
    throw new Error("Repair job not found")
  }
  return mapJobRow(row)
}

function workerItemIdsFromPayload(payload: Record<string, unknown> | undefined): string[] {
  if (!payload) return []
  const ids = new Set<string>()
  if (Array.isArray(payload.itemIds)) {
    for (const value of payload.itemIds) if (typeof value === "string" && value.trim()) ids.add(value.trim())
  }
  if (Array.isArray(payload.items)) {
    for (const value of payload.items) {
      if (!isRecord(value)) continue
      const id = typeof value.id === "string" ? value.id : typeof value.itemId === "string" ? value.itemId : ""
      if (id.trim()) ids.add(id.trim())
    }
  }
  return Array.from(ids)
}

function isWorkerItemComplete(item: DriveMigrationItem): boolean {
  const progress = isRecord(item.progress) ? item.progress : {}
  const repair = isRecord(progress.repairWorker) ? progress.repairWorker : null
  if (String(repair?.status ?? "").toLowerCase() === "completed") {
    const details = isRecord(repair?.details) ? repair.details : {}
    const finalMissing = Number(details.finalMissing ?? 0)
    const finalMismatched = Number(details.finalMismatched ?? 0)
    return Number.isFinite(finalMissing) && Number.isFinite(finalMismatched) && finalMissing === 0 && finalMismatched === 0
  }
  return false
}

/**
 * Materialize a durable shared object-shard queue for the worker lane. Each
 * shard spans every selected bucket; workers filter the object keys by shard
 * and can claim another shard as soon as they finish. Super Slurper
 * migrations never call this function.
 */
export async function ensureMigrationWorkerJobs(input: {
  migrationId: string
  mode?: RepairJobMode
}): Promise<{ created: number; existing: number; jobs: DriveRepairJob[] }> {
  const migration = await getMigration(input.migrationId)
  if (!migration) throw new Error("Migration not found")
  if (migration.options.executionMode !== "migration_workers") {
    return { created: 0, existing: 0, jobs: [] }
  }

  const items = await listMigrationItems(input.migrationId)
  const generation =
    typeof migration.options.workerGeneration === "number" && Number.isFinite(migration.options.workerGeneration)
      ? Math.max(1, Math.floor(migration.options.workerGeneration))
      : 1
  const shardCount =
    typeof migration.options.workerShardCount === "number" && Number.isFinite(migration.options.workerShardCount)
      ? Math.max(1, Math.min(MAX_WORKER_SHARD_COUNT, Math.floor(migration.options.workerShardCount)))
      : DEFAULT_WORKER_SHARD_COUNT
  // A bucket-create failure is kept out of the object queue. The next start
  // attempt can clear that marker after the target bucket becomes available.
  const queuedItems = items.filter(
    (item) => !isWorkerItemComplete(item) && item.slurperStatus !== "worker_bucket_create_failed"
  )
  if (queuedItems.length === 0) return { created: 0, existing: 0, jobs: [] }

  // Query the current generation by its durable key. A migration may contain
  // hundreds of historical/manual jobs; a generic newest-500 query could hide
  // an older current shard and make the orchestrator create a duplicate.
  const currentJobs = await listWorkerShardJobsByMigrationRaw(input.migrationId, generation, shardCount)
  const byWorkKey = new Map(currentJobs.filter((job) => job.workKey).map((job) => [job.workKey!, job]))
  const jobs: DriveRepairJob[] = []
  let created = 0
  let existing = 0

  const itemIds = queuedItems.map((item) => item.id)
  const missingShards: Array<{ index: number; workKey: string }> = []
  for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
    const workKey = `migration:${input.migrationId}:generation:${generation}:shard:${shardIndex}/${shardCount}`
    const known = byWorkKey.get(workKey)
    if (known) {
      existing += 1
      jobs.push(known)
      continue
    }
    missingShards.push({ index: shardIndex, workKey })
  }

  // Create missing shards in bounded batches. The unique work key still makes
  // concurrent orchestrator ticks idempotent, while avoiding a long serial
  // setup when a migration uses dozens of workers.
  for (let offset = 0; offset < missingShards.length; offset += 8) {
    const batch = missingShards.slice(offset, offset + 8)
    const createdBatch = await Promise.all(
      batch.map(({ index, workKey }) =>
        createRepairJob({
          migrationId: input.migrationId,
          mode: input.mode ?? "repair_and_verify",
          workKey,
          payload: {
            source: "migration_orchestrator",
            kind: "migration_shard",
            workerGeneration: generation,
            workerShard: { index, count: shardCount },
            itemIds,
            items: itemIds.map((id) => ({ id })),
          },
        }).then((job) => ({ job, created: job.workKey === workKey && !byWorkKey.has(workKey) }))
      )
    )
    for (const entry of createdBatch) {
      if (entry.created) created += 1
      else existing += 1
      jobs.push(entry.job)
      byWorkKey.set(entry.job.workKey ?? "", entry.job)
    }
  }

  return { created, existing, jobs }
}

/**
 * Once every shard in a worker generation is terminal-success, promote the
 * per-shard item state to a single completed item state. Shard jobs deliberately
 * leave items running so live-state reconciliation cannot complete a migration
 * after only one shard has finished.
 */
export async function finalizeCompletedMigrationWorkerShards(
  migrationId: string
): Promise<{ finalized: boolean; shardCount: number; jobs: number; items: number }> {
  const migration = await getMigration(migrationId)
  if (!migration || migration.options.executionMode !== "migration_workers") {
    return { finalized: false, shardCount: 0, jobs: 0, items: 0 }
  }

  const generation =
    typeof migration.options.workerGeneration === "number" && Number.isFinite(migration.options.workerGeneration)
      ? Math.max(1, Math.floor(migration.options.workerGeneration))
      : 1
  const shardCount =
    typeof migration.options.workerShardCount === "number" && Number.isFinite(migration.options.workerShardCount)
      ? Math.max(1, Math.min(MAX_WORKER_SHARD_COUNT, Math.floor(migration.options.workerShardCount)))
      : DEFAULT_WORKER_SHARD_COUNT
  const items = await listMigrationItems(migrationId)
  if (items.length === 0 || items.every(isWorkerItemComplete)) {
    return { finalized: true, shardCount, jobs: 0, items: 0 }
  }
  const jobs = await listWorkerShardJobsByMigrationRaw(migrationId, generation, shardCount)
  const jobsByIndex = new Map<number, DriveRepairJob>()
  for (const job of jobs) {
    const match = job.workKey?.match(/:shard:(\d+)\/(\d+)$/)
    if (!match || Number(match[2]) !== shardCount) continue
    const index = Number(match[1])
    if (Number.isInteger(index) && index >= 0 && index < shardCount && !jobsByIndex.has(index)) {
      jobsByIndex.set(index, job)
    }
  }
  if (jobsByIndex.size !== shardCount) {
    return { finalized: false, shardCount, jobs: jobs.length, items: 0 }
  }
  const shardJobs = Array.from(jobsByIndex.values())
  if (shardJobs.some((job) => job.status !== "completed")) {
    return { finalized: false, shardCount, jobs: jobs.length, items: 0 }
  }

  let finalizedItems = 0
  const now = new Date().toISOString()
  const count = (value: unknown): number => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
  }
  // Item progress is intentionally shared by all shards for the dashboard,
  // so two workers can race while publishing telemetry. Rebuild the durable
  // counters from each terminal shard result before promoting completion.
  const shardMetrics = new Map<string, { transferred: number; skipped: number; sourceObjects: number; sourceBytes: number }>()
  for (const shardJob of shardJobs) {
    const resultItems = isRecord(shardJob.result) && Array.isArray(shardJob.result.items) ? shardJob.result.items : []
    for (const raw of resultItems) {
      if (!isRecord(raw) || typeof raw.itemId !== "string") continue
      const current = shardMetrics.get(raw.itemId) ?? { transferred: 0, skipped: 0, sourceObjects: 0, sourceBytes: 0 }
      current.transferred += count(raw.transferred)
      current.skipped += count(raw.skipped)
      current.sourceObjects = Math.max(current.sourceObjects, count(raw.sourceObjectCount))
      current.sourceBytes = Math.max(current.sourceBytes, count(raw.sourceBytes))
      shardMetrics.set(raw.itemId, current)
    }
  }
  for (const item of items) {
    if (isWorkerItemComplete(item)) continue
    // Target-bucket provisioning failures are deliberately excluded from the
    // shared shard queue. Never let successful shards for other buckets
    // promote this item to completed while its destination is unavailable.
    if (item.slurperStatus === "worker_bucket_create_failed") continue
    const current = isRecord(item.progress) ? item.progress : {}
    const repair = isRecord(current.repairWorker) ? current.repairWorker : {}
    const live = isRecord(current.live) ? current.live : {}
    const details = isRecord(repair.details) ? repair.details : {}
    const slurper = isRecord(current.slurper) ? current.slurper.result : null
    const slurperTransferred = isRecord(current.slurperCumulative)
      ? count(current.slurperCumulative.transferredObjects)
      : isRecord(current.slurperNormalized)
        ? count(current.slurperNormalized.transferredObjects)
        : isRecord(slurper)
          ? count(slurper.transferredObjects)
          : 0
    const workerTransferred = Math.max(
      shardMetrics.get(item.id)?.transferred ?? 0,
      count(repair.cumulativeTransferred),
      count(repair.transferred),
      count(live.transferredObjects) - slurperTransferred
    )
    const skipped = Math.max(
      shardMetrics.get(item.id)?.skipped ?? 0,
      count(repair.cumulativeSkipped),
      count(repair.skipped)
    )
    const totalObjects = Math.max(
      count(item.sourceObjects),
      shardMetrics.get(item.id)?.sourceObjects ?? 0,
      count(details.sourceObjectCount),
      count(live.totalObjects)
    )
    const nextRepair = {
      ...repair,
      status: "completed",
      stage: "worker_completed",
      updatedAt: now,
      cumulativeTransferred: Math.max(0, workerTransferred),
      cumulativeSkipped: Math.max(0, skipped),
      details: {
        ...details,
        finalMissing: 0,
        finalMismatched: 0,
        resolvedAllObjects: true,
        shardCount,
        finalizedAt: now,
      },
    }
    const nextProgress = {
      ...current,
      stage: "worker_completed",
      repairWorker: nextRepair,
      repairWorkerStatus: "completed",
      slurperStatus: "completed",
      live: {
        ...live,
        updatedAt: now,
        status: "completed",
        transferredObjects:
          totalObjects > 0
            ? Math.max(totalObjects - Math.max(0, skipped), slurperTransferred + Math.max(0, workerTransferred))
            : slurperTransferred + Math.max(0, workerTransferred),
        skippedObjects: Math.max(count(live.skippedObjects), skipped),
        failedObjects: 0,
        unaccountedObjects: 0,
        verifyIssues: 0,
        totalObjects,
        workerStage: "worker_completed",
        workerStatus: "completed",
        repairJobId: shardJobs[shardJobs.length - 1]?.id ?? null,
      },
      syncMessage: `All ${shardCount} migration worker shards completed`,
    }
    await updateMigrationItem(item.id, {
      progress: nextProgress,
      slurperStatus: "completed",
      lastProgressAt: now,
      ...(totalObjects > 0 ? { sourceObjects: totalObjects } : {}),
    })
    finalizedItems += 1
  }

  return { finalized: finalizedItems > 0 || items.every(isWorkerItemComplete), shardCount, jobs: jobs.length, items: finalizedItems }
}

/**
 * Tell a pool worker whether it can stop polling. A missing or leased shard
 * is deliberately treated as active: another worker may still be processing
 * it, or the orchestrator may need to requeue it after a crash. Only a
 * terminal migration, a fully completed current generation, or a migration
 * with no eligible items is safe to stop on.
 */
export async function getMigrationWorkerPoolState(migrationId: string): Promise<{
  done: boolean
  status?: string
  reason?: string
}> {
  const migration = await getMigration(migrationId)
  if (!migration || migration.options.executionMode !== "migration_workers") return { done: false }
  if (["completed", "failed", "canceled"].includes(migration.status)) {
    return { done: true, status: migration.status, reason: "migration_terminal" }
  }
  if (!["running", "verifying"].includes(migration.status)) {
    return { done: true, status: migration.status, reason: "migration_not_active" }
  }

  const items = await listMigrationItems(migrationId)
  const eligibleItems = items.filter(
    (item) => !isWorkerItemComplete(item) && item.slurperStatus !== "worker_bucket_create_failed"
  )
  if (eligibleItems.length === 0) {
    return { done: true, status: migration.status, reason: items.length === 0 ? "no_items" : "no_eligible_items" }
  }

  const { generation, shardCount } = workerGenerationAndShardCount(migration)
  const jobs = await listWorkerShardJobsByMigrationRaw(migrationId, generation, shardCount)
  const indexes = new Set<number>()
  for (const job of jobs) {
    const shard = parseWorkerShardWorkKey(job.workKey)
    if (shard && shard.generation === generation && shard.count === shardCount) indexes.add(shard.index)
  }
  if (indexes.size !== shardCount) return { done: false }

  const currentShards = jobs.filter((job) => {
    const shard = parseWorkerShardWorkKey(job.workKey)
    return Boolean(shard && shard.generation === generation && shard.count === shardCount)
  })
  if (currentShards.length < shardCount || currentShards.some((job) => job.status !== "completed")) {
    // A failed shard with retries remaining is still active: the next
    // orchestrator tick will put the same durable row back in the queue. Once
    // every shard is terminal and at least one failure has exhausted its retry
    // budget, there is no useful work for a long-lived GitHub runner to poll.
    // Let it stop cleanly; live-state reconciliation will expose the migration
    // failure and a user retry creates a new generation.
    const exhaustedFailure = currentShards.some((job) => {
      if (job.status !== "failed") return false
      const retryCount = isRecord(job.result) ? Number(job.result.retryCount ?? 0) : 0
      return Number.isFinite(retryCount) && retryCount >= MAX_WORKER_REQUEUE_ATTEMPTS
    })
    const allTerminal = currentShards.every((job) => ["completed", "failed", "canceled"].includes(job.status))
    if (exhaustedFailure && allTerminal) {
      return { done: true, status: "failed", reason: "shard_retry_exhausted" }
    }
    return { done: false }
  }
  return { done: true, status: migration.status, reason: "all_shards_completed" }
}

/** Requeue a claimed worker shard after its worker has disappeared. */
export async function requeueStaleMigrationWorkerJobs(input?: { migrationId?: string }): Promise<number> {
  const scopedMigration = input?.migrationId ? await getMigration(input.migrationId) : null
  const scopedGeneration = scopedMigration ? workerGenerationAndShardCount(scopedMigration) : null
  const jobs =
    input?.migrationId && scopedMigration && scopedMigration.options.executionMode === "migration_workers"
      ? await listWorkerShardJobsByMigrationRaw(input.migrationId, scopedGeneration?.generation ?? 1, scopedGeneration?.shardCount ?? 32)
      : await listRepairJobsRaw(500)
  const agents = await listAgents()
  const agentById = new Map(agents.map((agent) => [agent.id, agent]))
  let requeued = 0
  for (const job of jobs) {
    if (input?.migrationId && job.migrationId !== input.migrationId) continue
    const migration = input?.migrationId ? scopedMigration : await getMigration(job.migrationId).catch(() => null)
    if (!migration || migration.options.executionMode !== "migration_workers") continue
    const workKey = parseWorkerShardWorkKey(job.workKey)
    const current = workerGenerationAndShardCount(migration)
    // A retry creates a new generation. Never revive an old generation: doing
    // so would let a stale worker process the same object set again while the
    // current generation is already being coordinated.
    if (
      !workKey ||
      workKey.migrationId !== job.migrationId ||
      workKey.generation !== current.generation ||
      workKey.count !== current.shardCount
    ) {
      continue
    }

    // A failed shard is retryable because the failure may have been a worker,
    // network, or provider transient. Keep the same work key and row so the
    // database uniqueness guarantee still prevents duplicate shard records.
    // User cancellation remains terminal and is deliberately not retried.
    if (job.status === "failed") {
      const previousAttempts = isRecord(job.result) ? Number(job.result.retryCount ?? 0) : 0
      const retryCount = Number.isFinite(previousAttempts) ? Math.max(0, Math.floor(previousAttempts)) : 0
      if (retryCount >= MAX_WORKER_REQUEUE_ATTEMPTS) continue
      const now = new Date().toISOString()
      const supabase = getSupabaseServerClient()
      const { data, error } = await supabase
        .from(REPAIR_JOBS_TABLE)
        .update({
          status: "pending",
          claimed_by_agent_id: null,
          claimed_at: null,
          started_at: null,
          completed_at: null,
          last_heartbeat_at: null,
          summary: `Retrying failed worker shard (attempt ${retryCount + 1}/${MAX_WORKER_REQUEUE_ATTEMPTS})`,
          error: null,
          result: {
            ...(job.result ?? {}),
            retryCount: retryCount + 1,
            lastRetryAt: now,
          },
          updated_at: now,
        })
        .eq("id", job.id)
        .eq("status", "failed")
        .select("id")
      if (!error && Array.isArray(data) && data.length > 0) requeued += 1
      continue
    }

    if (!["claimed", "running"].includes(job.status) || !job.claimedByAgentId) continue
    const agent = agentById.get(job.claimedByAgentId)
    if (!agent) continue
    const freshJob = isRecentIso(job.lastHeartbeatAt, 120_000)
    // An idle worker heartbeat must not keep an unrelated lease alive. The
    // bundled worker reports its current job explicitly; retain the fallback
    // for older agents that never sent that marker.
    const agentMetadata = isRecord(agent.metadata) ? agent.metadata : {}
    const hasCurrentJobMarker = Object.prototype.hasOwnProperty.call(agentMetadata, "currentJobId")
    const freshAgent =
      isRecentIso(agent.lastHeartbeatAt, 120_000) &&
      (!hasCurrentJobMarker || agentMetadata.currentJobId === job.id)
    const activeRun =
      agent.latestRun &&
      ["pending", "running"].includes(agent.latestRun.status) &&
      isRecentIso(agent.latestRun.updatedAt, 120_000)
    if (freshJob || freshAgent || activeRun) continue

    const supabase = getSupabaseServerClient()
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from(REPAIR_JOBS_TABLE)
      .update({
        status: "pending",
        claimed_by_agent_id: null,
        claimed_at: null,
        started_at: null,
        completed_at: null,
        last_heartbeat_at: now,
        summary: "Requeued after the worker heartbeat expired",
        error: null,
        updated_at: now,
      })
      .eq("id", job.id)
      .eq("status", job.status)
      .eq("claimed_by_agent_id", job.claimedByAgentId)
      .select("id")
    if (!error && Array.isArray(data) && data.length > 0) requeued += 1
  }
  if (requeued > 0 && input?.migrationId) {
    await updateMigration(input.migrationId, {
      syncStatus: "ok",
      syncMessage: `Requeued ${requeued} worker shard${requeued === 1 ? "" : "s"}`,
      lastSyncedAt: new Date().toISOString(),
    }).catch(() => undefined)
  }
  return requeued
}

export async function buildRepairJobExecutionPayload(job: DriveRepairJob): Promise<Record<string, unknown>> {
  const migration = await getMigration(job.migrationId)
  if (!migration) throw new Error("Migration not found")
  const allItems = await listMigrationItems(job.migrationId)
  const requestedIds = workerItemIdsFromPayload(job.payload)
  const items = requestedIds.length > 0 ? allItems.filter((item) => requestedIds.includes(item.id)) : allItems
  if (requestedIds.length > 0 && items.length !== requestedIds.length) {
    throw new Error("Worker job references a migration item that no longer exists")
  }
  const accounts = await getAllAccounts()
  const source = accounts.find((account) => account.id === migration.sourceAccountId)
  const target = accounts.find((account) => account.id === migration.targetAccountId)
  if (!source || !target || !source.cloudflareAccountId || !target.cloudflareAccountId) {
    throw new Error("Source/target accounts are not fully configured")
  }

  const pathPrefix = typeof migration.options.pathPrefix === "string" && migration.options.pathPrefix.trim().length > 0
    ? migration.options.pathPrefix
    : null

  return {
    job: {
      id: job.id,
      mode: job.mode,
      migrationId: migration.id,
      verifyAllBuckets: true,
      strictCompletion: true,
      kind: typeof job.payload.kind === "string" ? job.payload.kind : undefined,
    },
    ...(isRecord(job.payload.workerShard) ? { workerShard: job.payload.workerShard } : {}),
    ...(typeof job.payload.workerGeneration === "number" ? { workerGeneration: job.payload.workerGeneration } : {}),
    migration: {
      id: migration.id,
      options: migration.options,
      pathPrefix,
    },
    source: {
      accountId: source.cloudflareAccountId,
      accessKeyId: source.r2AccessKeyId,
      secretAccessKey: source.r2SecretAccessKey,
    },
    target: {
      accountId: target.cloudflareAccountId,
      accessKeyId: target.r2AccessKeyId,
      secretAccessKey: target.r2SecretAccessKey,
    },
    items: items.map((item) => ({
      id: item.id,
      sourceBucket: item.sourceBucket,
      targetBucket: item.targetBucket,
      sourceObjects: item.sourceObjects ?? 0,
      sourceBytes: item.sourceBytes ?? 0,
      slurperStatus: item.slurperStatus ?? null,
      progress: item.progress,
    })),
  }
}

export async function applyRepairJobItemUpdate(input: {
  migrationId: string
  itemId: string
  repairJobId: string
  stage: string
  status: string
  summary?: string
  details?: Record<string, unknown>
  transferred?: number
  failed?: number
  skipped?: number
  expectedAgentId?: string
}): Promise<DriveMigrationItem> {
  if (input.expectedAgentId) {
    const ownedJob = await getRepairJobRaw(input.repairJobId)
    if (
      !ownedJob ||
      ownedJob.claimedByAgentId !== input.expectedAgentId ||
      !["claimed", "running"].includes(ownedJob.status)
    ) {
      throw new Error("This job is no longer owned by this worker")
    }
  }
  const item = (await listMigrationItems(input.migrationId)).find((row) => row.id === input.itemId)
  if (!item) throw new Error("Migration item not found")
  const now = new Date().toISOString()
  const current = item.progress && typeof item.progress === "object" ? (item.progress as Record<string, unknown>) : {}
  const repair = isRecord(current.repairWorker) ? (current.repairWorker as Record<string, unknown>) : {}
  const live = isRecord(current.live) ? (current.live as Record<string, unknown>) : {}
  const slurper = [current.slurperCumulative, current.slurperNormalized, isRecord(current.slurper) ? current.slurper.result : null]
    .find(isRecord)
  const slurperTransferred = typeof slurper?.transferredObjects === "number" ? slurper.transferredObjects : 0
  const slurperSkipped = typeof slurper?.skippedObjects === "number" ? slurper.skippedObjects : 0
  const sameRepairJob = repair.jobId === input.repairJobId
  const inferredPriorWorkerTransferred = Math.max(
    0,
    typeof live.transferredObjects === "number" ? live.transferredObjects - slurperTransferred : 0
  )
  const baselineTransferred = sameRepairJob
    ? typeof repair.baselineTransferred === "number"
      ? repair.baselineTransferred
      : 0
    : typeof repair.cumulativeTransferred === "number"
      ? repair.cumulativeTransferred
      : inferredPriorWorkerTransferred
  const baselineSkipped = sameRepairJob
    ? typeof repair.baselineSkipped === "number"
      ? repair.baselineSkipped
      : 0
    : typeof repair.cumulativeSkipped === "number"
      ? repair.cumulativeSkipped
      : Math.max(0, typeof live.skippedObjects === "number" ? live.skippedObjects - slurperSkipped : 0)
  const details = input.details && typeof input.details === "object" ? input.details : {}
  const stage = String(input.stage || "")
  const sourceObjectCount =
    typeof details.sourceObjectCount === "number"
      ? details.sourceObjectCount
      : typeof live.totalObjects === "number"
        ? live.totalObjects
        : typeof item.sourceObjects === "number"
          ? item.sourceObjects
          : 0
  const sourceBytes =
    typeof details.sourceBytes === "number"
      ? details.sourceBytes
      : typeof item.sourceBytes === "number"
        ? item.sourceBytes
        : 0
  const transferred = typeof input.transferred === "number" ? input.transferred : sameRepairJob && typeof repair.transferred === "number" ? Number(repair.transferred) : 0
  const failed = typeof input.failed === "number" ? input.failed : sameRepairJob && typeof repair.failed === "number" ? Number(repair.failed) : 0
  const skipped = typeof input.skipped === "number" ? input.skipped : sameRepairJob && typeof repair.skipped === "number" ? Number(repair.skipped) : 0
  const cumulativeTransferred = baselineTransferred + transferred
  const cumulativeSkipped = Math.max(baselineSkipped, skipped)
  const finalMissing = typeof details.finalMissing === "number" ? details.finalMissing : 0
  const finalMismatched = typeof details.finalMismatched === "number" ? details.finalMismatched : 0
  const liveStatus =
    input.status === "completed"
      ? finalMissing === 0 && finalMismatched === 0
        ? "completed"
        : "failed"
      : input.status === "failed"
        ? "failed"
        : input.status === "canceled"
          ? "aborted"
          : stage.includes("scan")
            ? "scanning"
            : stage.includes("verify")
              ? "verifying"
              : "running"

  const nextRepair = {
    ...repair,
    jobId: input.repairJobId,
    baselineTransferred,
    baselineSkipped,
    cumulativeTransferred,
    cumulativeSkipped,
    stage,
    status: input.status,
    updatedAt: now,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.details ? { details: input.details } : {}),
    transferred,
    failed,
    skipped,
  }

  const progress = {
    ...current,
    stage,
    repairWorker: nextRepair,
    live: {
      ...live,
      updatedAt: now,
      status: liveStatus,
      transferredObjects:
        sourceObjectCount > 0
          ? Math.min(sourceObjectCount, slurperTransferred + cumulativeTransferred)
          : slurperTransferred + cumulativeTransferred,
      skippedObjects: Math.max(slurperSkipped, cumulativeSkipped),
      failedObjects: liveStatus === "completed" ? 0 : Math.max(failed, finalMissing + finalMismatched),
      unaccountedObjects: liveStatus === "completed" ? 0 : typeof live.unaccountedObjects === "number" ? live.unaccountedObjects : 0,
      verifyIssues: liveStatus === "completed" ? 0 : finalMissing + finalMismatched,
      totalObjects: sourceObjectCount,
      workerStage: stage || null,
      workerStatus: input.status || null,
      repairJobId: input.repairJobId,
    },
    ...(input.status ? { repairWorkerStatus: input.status } : {}),
    ...(input.summary ? { syncMessage: input.summary } : {}),
    ...(input.status === "failed" && input.summary ? { error: input.summary, lastError: input.summary } : {}),
  }

  const slurperStatus =
    input.status === "completed" ? "completed" : input.status === "failed" ? "verification_failed" : item.slurperStatus ?? null

  return updateMigrationItem(item.id, {
    progress,
    slurperStatus,
    lastProgressAt: now,
    ...(sourceObjectCount > 0 ? { sourceObjects: sourceObjectCount } : {}),
    ...(sourceBytes > 0 ? { sourceBytes } : {}),
  })
}
