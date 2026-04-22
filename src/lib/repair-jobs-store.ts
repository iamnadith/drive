import crypto from "crypto"
import {
  getAgentGithubToken,
  listAgents,
  updateAgent,
  updateAgentRun,
  type DriveAgent,
  type DriveAgentRun,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function mapJobRow(row: DriveRepairJobRow): DriveRepairJob {
  return {
    id: row.id,
    migrationId: row.migration_id,
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
  dispatchRequestedAt: unknown
) {
  if (!Array.isArray(runs) || runs.length === 0) return null

  const requestedAt =
    typeof dispatchRequestedAt === "string" && dispatchRequestedAt.trim().length > 0 ? Date.parse(dispatchRequestedAt) : Number.NaN

  if (!Number.isFinite(requestedAt)) return runs[0] ?? null

  return (
    runs.find((candidate) => {
      const createdAt = Date.parse(candidate.createdAt || "")
      if (!Number.isFinite(createdAt)) return false
      return createdAt >= requestedAt - 60_000
    }) ?? null
  )
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
        githubRun = matchGithubRunToDispatch(runs, (latestRun.payload ?? {}).dispatchRequestedAt)
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
    const activeJobs = await listRepairJobsRaw(100)

    for (const job of activeJobs) {
      if (!job.claimedByAgentId) continue
      if (!["pending", "claimed", "running"].includes(job.status)) continue

      const agent = activeAgentById.get(job.claimedByAgentId)
      if (!agent) continue
      if (input?.jobId && job.id !== input.jobId) continue
      if (input?.migrationId && job.migrationId !== input.migrationId) continue

      if (agent.provider === "self_hosted" || agent.provider === "local") {
        const workerOnline = agent.status === "online" && isRecentIso(agent.lastHeartbeatAt, 60_000)
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
}): Promise<DriveRepairJob> {
  const migration = await getMigration(input.migrationId)
  if (!migration) throw new Error("Migration not found")

  const supabase = getSupabaseServerClient()
  const row = {
    id: crypto.randomUUID(),
    migration_id: input.migrationId,
    requested_by_agent_id: input.requestedByAgentId ?? null,
    status: "pending",
    mode: input.mode ?? "repair_and_verify",
    payload: input.payload ?? {},
    progress: {},
    result: {},
  }

  const { data, error } = await supabase.from(REPAIR_JOBS_TABLE).insert(row).select("*").single()
  if (error) throw normalizeSupabaseError(error)

  await updateMigration(input.migrationId, {
    syncStatus: "ok",
    syncMessage: "Queued recovery/verification worker job",
    lastSyncedAt: new Date().toISOString(),
  }).catch(() => undefined)

  return mapJobRow(data as DriveRepairJobRow)
}

export async function claimRepairJob(agentId: string): Promise<DriveRepairJob | null> {
  const supabase = getSupabaseServerClient()
  const { data: pendingRows, error: listError } = await supabase
    .from(REPAIR_JOBS_TABLE)
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
  if (listError) throw normalizeSupabaseError(listError)
  const candidate = Array.isArray(pendingRows) ? (pendingRows[0] as DriveRepairJobRow | undefined) : undefined
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
  if (existing.status === "completed" || existing.status === "failed" || existing.status === "canceled") {
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

  const { data, error } = await supabase.from(REPAIR_JOBS_TABLE).update(dbUpdates).eq("id", id).select("*").single()
  if (error) throw normalizeSupabaseError(error)
  return mapJobRow(data as DriveRepairJobRow)
}

export async function buildRepairJobExecutionPayload(job: DriveRepairJob): Promise<Record<string, unknown>> {
  const migration = await getMigration(job.migrationId)
  if (!migration) throw new Error("Migration not found")
  const items = await listMigrationItems(job.migrationId)
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
    },
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
  stage: string
  status: string
  summary?: string
  details?: Record<string, unknown>
  transferred?: number
  failed?: number
  skipped?: number
}): Promise<DriveMigrationItem> {
  const item = (await listMigrationItems(input.migrationId)).find((row) => row.id === input.itemId)
  if (!item) throw new Error("Migration item not found")
  const now = new Date().toISOString()
  const current = item.progress && typeof item.progress === "object" ? (item.progress as Record<string, unknown>) : {}
  const repair = isRecord(current.repairWorker) ? (current.repairWorker as Record<string, unknown>) : {}
  const live = isRecord(current.live) ? (current.live as Record<string, unknown>) : {}
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
  const transferred = typeof input.transferred === "number" ? input.transferred : typeof repair.transferred === "number" ? Number(repair.transferred) : 0
  const failed = typeof input.failed === "number" ? input.failed : typeof repair.failed === "number" ? Number(repair.failed) : 0
  const skipped = typeof input.skipped === "number" ? input.skipped : typeof repair.skipped === "number" ? Number(repair.skipped) : 0
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
      transferredObjects: liveStatus === "completed" && sourceObjectCount > 0 ? Math.max(transferred, Math.max(0, sourceObjectCount - skipped)) : transferred,
      skippedObjects: skipped,
      failedObjects: liveStatus === "completed" ? 0 : Math.max(failed, finalMissing + finalMismatched),
      unaccountedObjects: liveStatus === "completed" ? 0 : typeof live.unaccountedObjects === "number" ? live.unaccountedObjects : 0,
      verifyIssues: liveStatus === "completed" ? 0 : finalMissing + finalMismatched,
      totalObjects: sourceObjectCount,
      workerStage: stage || null,
      workerStatus: input.status || null,
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
