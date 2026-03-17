import crypto from "crypto"
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

export async function listRepairJobs(limit = 50): Promise<DriveRepairJob[]> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(REPAIR_JOBS_TABLE).select("*").order("created_at", { ascending: false }).limit(limit)
  if (error) throw normalizeSupabaseError(error)
  return (Array.isArray(data) ? (data as DriveRepairJobRow[]) : []).map(mapJobRow)
}

export async function listRepairJobsByMigration(migrationId: string, limit = 20): Promise<DriveRepairJob[]> {
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
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(REPAIR_JOBS_TABLE).select("*").eq("id", id).limit(1)
  if (error) throw normalizeSupabaseError(error)
  const row = Array.isArray(data) ? (data[0] as DriveRepairJobRow | undefined) : undefined
  return row ? mapJobRow(row) : null
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

  const nextRepair = {
    ...repair,
    stage: input.stage,
    status: input.status,
    updatedAt: now,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.details ? { details: input.details } : {}),
    ...(typeof input.transferred === "number" ? { transferred: input.transferred } : {}),
    ...(typeof input.failed === "number" ? { failed: input.failed } : {}),
    ...(typeof input.skipped === "number" ? { skipped: input.skipped } : {}),
  }

  const progress = {
    ...current,
    stage: input.stage,
    repairWorker: nextRepair,
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
  })
}
