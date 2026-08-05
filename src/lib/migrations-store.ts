import crypto from "crypto"
import { getSupabaseServerClient } from "./supabase"

export type MigrationStatus = "draft" | "running" | "verifying" | "completed" | "failed" | "canceled"
export type MigrationSyncStatus = "idle" | "syncing" | "ok" | "error"

export type MigrationOptions = {
  overwrite?: boolean
  concurrency?: number
  includeBuckets?: string[]
  excludeBuckets?: string[]
  pathPrefix?: string | null
  sourceMode?: "r2" | "s3"
  manualCompleted?: boolean
  targetActivatedAt?: string
  historyReadOnlyAt?: string
  historyReadOnlyReason?: string

  // When true (default), after Super Slurper completes a bucket we verify source→destination
  // object listings (key + size) before marking the migration completed.
  verifyAfterCopy?: boolean

  // When true, destination extras are treated as failure (default: false; merge-friendly).
  verifyStrictDestination?: boolean

  // Verification mode. "keys-and-size" verifies object presence + size. "sha256-small"
  // additionally hashes small objects to detect same-size corruption.
  verifyMode?: "keys-and-size" | "sha256-small"

  // Max object size (bytes) to SHA-256 hash when verifyMode="sha256-small".
  verifyHashMaxBytes?: number
}

export interface DriveMigration {
  id: string
  sourceAccountId: string
  targetAccountId: string
  status: MigrationStatus
  options: MigrationOptions
  createdAt: string
  startedAt?: string
  completedAt?: string
  lastSyncedAt?: string
  syncStatus?: MigrationSyncStatus
  syncMessage?: string
  updatedAt?: string
}

export interface DriveMigrationItem {
  id: string
  migrationId: string
  sourceBucket: string
  targetBucket: string
  sourceJurisdiction?: string
  sourceStorageClass?: string
  sourceObjects?: number
  sourceBytes?: number
  slurperJobId?: string
  slurperStatus?: string
  progress: Record<string, unknown>
  lastProgressAt?: string
  createdAt: string
  updatedAt?: string
}

type DriveMigrationRow = {
  id: string
  source_account_id: string
  target_account_id: string
  status: MigrationStatus
  options: MigrationOptions | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  last_synced_at: string | null
  sync_status: MigrationSyncStatus | null
  sync_message: string | null
  updated_at: string | null
}

type DriveMigrationItemRow = {
  id: string
  migration_id: string
  source_bucket: string
  target_bucket: string
  source_jurisdiction: string | null
  source_storage_class: string | null
  source_objects: number | null
  source_bytes: number | null
  slurper_job_id: string | null
  slurper_status: string | null
  progress: Record<string, unknown> | null
  last_progress_at: string | null
  created_at: string
  updated_at: string | null
}

const MIGRATIONS_TABLE = "drive_migrations"
const MIGRATION_ITEMS_TABLE = "drive_migration_items"

type ProgressEvent = {
  at: string
  stage?: string
  status?: string | null
  message?: string
  data?: Record<string, unknown>
}

function appendProgressEvent(
  progress: Record<string, unknown>,
  event: ProgressEvent
): Record<string, unknown> {
  const existing = Array.isArray(progress.events) ? (progress.events as unknown[]) : []
  const previous = existing.at(-1)
  if (previous && typeof previous === "object") {
    const last = previous as Record<string, unknown>
    const sameData = JSON.stringify(last.data ?? null) === JSON.stringify(event.data ?? null)
    if (
      String(last.stage ?? "") === String(event.stage ?? "") &&
      String(last.status ?? "") === String(event.status ?? "") &&
      String(last.message ?? "") === String(event.message ?? "") &&
      sameData
    ) {
      return { ...progress, events: existing }
    }
  }
  const next = [...existing, event]
  const capped = next.length > 500 ? next.slice(next.length - 500) : next
  return { ...progress, events: capped }
}

function normalizeSupabaseError(error: { message: string }): Error {
  const message = String(error?.message ?? "Supabase error")
  if (message.includes("Could not find the table") && message.includes(MIGRATIONS_TABLE)) {
    return new Error(
      `Supabase table '${MIGRATIONS_TABLE}' is missing. Create it by running 'supabase/drive_schema.sql' in the Supabase SQL editor for ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "your project"}.`
    )
  }
  if (message.includes("Could not find the table") && message.includes(MIGRATION_ITEMS_TABLE)) {
    return new Error(
      `Supabase table '${MIGRATION_ITEMS_TABLE}' is missing. Create it by running 'supabase/drive_schema.sql' in the Supabase SQL editor for ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "your project"}.`
    )
  }
  if (message.includes("column") && message.includes("drive_migration_items") && message.includes("slurper_status")) {
    return new Error(
      "Your Supabase schema is outdated: column 'drive_migration_items.slurper_status' is missing. " +
        `Make sure you're running it for the same project this app is using (${process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "your project"}).\n\n` +
        "Run the latest `supabase/drive_schema.sql`, or apply this patch in Supabase SQL editor:\n\n" +
        "alter table public.drive_migration_items add column if not exists slurper_status text;\n" +
        "alter table public.drive_migration_items add column if not exists slurper_job_id text;\n" +
        "alter table public.drive_migration_items add column if not exists last_progress_at timestamptz;\n" +
        "alter table public.drive_migration_items add column if not exists progress jsonb not null default '{}'::jsonb;\n\n" +
        "If you already added the columns and still see this, reload Supabase API schema cache:\n" +
        "select pg_notify('pgrst', 'reload schema');\n"
    )
  }
  return new Error(message)
}

function isSlurperStatusColumnError(error: unknown): boolean {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "")
  return (
    message.includes("drive_migration_items.slurper_status") ||
    (message.includes("drive_migration_items") && message.includes("slurper_status") && message.includes("column"))
  )
}

function mapMigrationRow(row: DriveMigrationRow): DriveMigration {
  return {
    id: row.id,
    sourceAccountId: row.source_account_id,
    targetAccountId: row.target_account_id,
    status: row.status,
    options: row.options ?? {},
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
    syncStatus: row.sync_status ?? undefined,
    syncMessage: row.sync_message ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  }
}

function mapMigrationItemRow(row: DriveMigrationItemRow): DriveMigrationItem {
  return {
    id: row.id,
    migrationId: row.migration_id,
    sourceBucket: row.source_bucket,
    targetBucket: row.target_bucket,
    sourceJurisdiction: row.source_jurisdiction ?? undefined,
    sourceStorageClass: row.source_storage_class ?? undefined,
    sourceObjects: row.source_objects ?? undefined,
    sourceBytes: row.source_bytes ?? undefined,
    slurperJobId: row.slurper_job_id ?? undefined,
    slurperStatus: row.slurper_status ?? undefined,
    progress: row.progress ?? {},
    lastProgressAt: row.last_progress_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  }
}

export async function listMigrations(limit = 50): Promise<DriveMigration[]> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(MIGRATIONS_TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) throw normalizeSupabaseError(error)
  return (data as DriveMigrationRow[]).map(mapMigrationRow)
}

export async function listMigrationsByAccount(
  accountId: string,
  limit = 200
): Promise<DriveMigration[]> {
  const supabase = getSupabaseServerClient()

  const [sourceRes, targetRes] = await Promise.all([
    supabase
      .from(MIGRATIONS_TABLE)
      .select("*")
      .eq("source_account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from(MIGRATIONS_TABLE)
      .select("*")
      .eq("target_account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(limit),
  ])

  if (sourceRes.error) throw normalizeSupabaseError(sourceRes.error)
  if (targetRes.error) throw normalizeSupabaseError(targetRes.error)

  const combined = [
    ...((sourceRes.data as DriveMigrationRow[]) ?? []),
    ...((targetRes.data as DriveMigrationRow[]) ?? []),
  ]

  const unique = new Map<string, DriveMigrationRow>()
  for (const row of combined) unique.set(row.id, row)

  return Array.from(unique.values())
    .sort((a, b) => {
      const at = Date.parse(a.created_at || "")
      const bt = Date.parse(b.created_at || "")
      if (!Number.isNaN(at) && !Number.isNaN(bt)) return bt - at
      return (b.created_at || "").localeCompare(a.created_at || "")
    })
    .map(mapMigrationRow)
}

export async function getMigration(id: string): Promise<DriveMigration | null> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(MIGRATIONS_TABLE)
    .select("*")
    .eq("id", id)
    .limit(1)

  if (error) throw normalizeSupabaseError(error)
  const row = (data as DriveMigrationRow[])[0]
  return row ? mapMigrationRow(row) : null
}

export async function listMigrationItems(migrationId: string): Promise<DriveMigrationItem[]> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(MIGRATION_ITEMS_TABLE)
    .select("*")
    .eq("migration_id", migrationId)
    .order("source_bucket", { ascending: true })

  if (error) throw normalizeSupabaseError(error)
  return (data as DriveMigrationItemRow[]).map(mapMigrationItemRow)
}

export async function deleteMigration(id: string): Promise<void> {
  const supabase = getSupabaseServerClient()

  const { error } = await supabase.from(MIGRATIONS_TABLE).delete().eq("id", id)
  if (error) throw normalizeSupabaseError(error)
}

export async function createMigration(input: {
  sourceAccountId: string
  targetAccountId: string
  options?: MigrationOptions
  items: Array<{
    sourceBucket: string
    targetBucket: string
    sourceJurisdiction?: string
    sourceStorageClass?: string
    sourceObjects?: number
    sourceBytes?: number
  }>
}): Promise<{ migration: DriveMigration; items: DriveMigrationItem[] }> {
  const supabase = getSupabaseServerClient()

  const now = new Date().toISOString()
  const migrationId = crypto.randomUUID()

  const { data: migrationRow, error: migrationError } = await supabase
    .from(MIGRATIONS_TABLE)
    .insert({
      id: migrationId,
      source_account_id: input.sourceAccountId,
      target_account_id: input.targetAccountId,
      status: "draft",
      options: input.options ?? {},
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single()

  if (migrationError) throw normalizeSupabaseError(migrationError)

  const itemRows = input.items.map((item) => ({
    id: crypto.randomUUID(),
    migration_id: migrationId,
    source_bucket: item.sourceBucket,
    target_bucket: item.targetBucket,
    source_jurisdiction: item.sourceJurisdiction ?? null,
    source_storage_class: item.sourceStorageClass ?? null,
    source_objects: typeof item.sourceObjects === "number" ? item.sourceObjects : null,
    source_bytes: typeof item.sourceBytes === "number" ? item.sourceBytes : null,
    progress: {},
    created_at: now,
    updated_at: now,
  }))

  if (itemRows.length === 0) {
    return {
      migration: mapMigrationRow(migrationRow as DriveMigrationRow),
      items: [],
    }
  }

  const { data: createdItems, error: itemsError } = await supabase
    .from(MIGRATION_ITEMS_TABLE)
    .insert(itemRows)
    .select("*")

  if (itemsError) throw normalizeSupabaseError(itemsError)

  return {
    migration: mapMigrationRow(migrationRow as DriveMigrationRow),
    items: (createdItems as DriveMigrationItemRow[]).map(mapMigrationItemRow),
  }
}

export async function updateMigration(
  id: string,
  updates: Partial<Pick<DriveMigration, "status" | "lastSyncedAt" | "syncStatus" | "syncMessage" | "options">> & {
    // Allow explicit null to clear DB fields.
    startedAt?: string | null
    completedAt?: string | null
  }
): Promise<DriveMigration> {
  const supabase = getSupabaseServerClient()

  const dbUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (updates.status !== undefined) dbUpdates.status = updates.status
  if (updates.startedAt !== undefined) dbUpdates.started_at = updates.startedAt ?? null
  if (updates.completedAt !== undefined) dbUpdates.completed_at = updates.completedAt ?? null
  if (updates.lastSyncedAt !== undefined) dbUpdates.last_synced_at = updates.lastSyncedAt ?? null
  if (updates.syncStatus !== undefined) dbUpdates.sync_status = updates.syncStatus ?? null
  if (updates.syncMessage !== undefined) dbUpdates.sync_message = updates.syncMessage ?? null
  if (updates.options !== undefined) dbUpdates.options = updates.options ?? {}

  const { data, error } = await supabase
    .from(MIGRATIONS_TABLE)
    .update(dbUpdates)
    .eq("id", id)
    .select("*")
    .single()

  if (error) throw normalizeSupabaseError(error)
  return mapMigrationRow(data as DriveMigrationRow)
}

export async function claimMigrationSyncLock(input: {
  migrationId: string
  // If the last sync is older than this many ms, allow another sync to take over.
  ttlMs?: number
  message?: string
}): Promise<boolean> {
  const supabase = getSupabaseServerClient()
  const now = new Date()
  const nowIso = now.toISOString()
  const ttlMs = typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs) ? Math.max(500, input.ttlMs) : 12_000
  const cutoffIso = new Date(Date.now() - ttlMs).toISOString()

  // PostgREST requires quoting timestamps (they contain `:`) inside logic trees.
  // Example: last_synced_at.lt."2026-01-31T12:34:56.789Z"
  const cutoffQuoted = `"${cutoffIso}"`

  const { data, error } = await supabase
    .from(MIGRATIONS_TABLE)
    .update({
      sync_status: "syncing",
      sync_message: input.message ?? "Syncing",
      last_synced_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", input.migrationId)
    .or(`sync_status.is.null,sync_status.neq.syncing,last_synced_at.is.null,last_synced_at.lt.${cutoffQuoted}`)
    .select("id")

  if (error) throw normalizeSupabaseError(error)
  return Array.isArray(data) && data.length > 0
}

export async function updateMigrationItem(
  id: string,
  updates: Partial<Pick<DriveMigrationItem, "progress" | "lastProgressAt" | "sourceObjects" | "sourceBytes">> & {
    // Allow explicit null to clear DB fields.
    slurperJobId?: string | null
    slurperStatus?: string | null
  }
): Promise<DriveMigrationItem> {
  const supabase = getSupabaseServerClient()

  const dbUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (updates.slurperJobId !== undefined) dbUpdates.slurper_job_id = updates.slurperJobId ?? null
  if (updates.slurperStatus !== undefined) dbUpdates.slurper_status = updates.slurperStatus ?? null
  if (updates.progress !== undefined) {
    // Merge with latest stored progress to avoid stale writers dropping verify state/events.
    const { data: currentRows, error: currentErr } = await supabase
      .from(MIGRATION_ITEMS_TABLE)
      .select("progress")
      .eq("id", id)
      .limit(1)
    if (currentErr) throw normalizeSupabaseError(currentErr)
    const currentRow = (currentRows as Array<{ progress: unknown }> | null)?.[0]
    const currentProgress =
      currentRow &&
      typeof currentRow.progress === "object" &&
      currentRow.progress !== null
        ? (currentRow.progress as Record<string, unknown>)
        : {}
    const incomingProgress =
      updates.progress && typeof updates.progress === "object"
        ? (updates.progress as Record<string, unknown>)
        : {}
    const nextProgress: Record<string, unknown> = { ...currentProgress, ...incomingProgress }
    if (updates.slurperStatus !== undefined) nextProgress.slurperStatus = updates.slurperStatus ?? null

    const stage = typeof nextProgress.stage === "string" ? nextProgress.stage : undefined
    const error = typeof nextProgress.error === "string" ? nextProgress.error : undefined
    const lastError = typeof nextProgress.lastError === "string" ? nextProgress.lastError : undefined
    const message = error ?? lastError
    const status = updates.slurperStatus ?? null
    if (stage || message || updates.slurperStatus !== undefined) {
      dbUpdates.progress = appendProgressEvent(nextProgress, {
        at: new Date().toISOString(),
        stage,
        status,
        message,
      })
    } else {
      dbUpdates.progress = nextProgress
    }
  }
  if (updates.lastProgressAt !== undefined)
    dbUpdates.last_progress_at = updates.lastProgressAt ?? null
  if (updates.sourceObjects !== undefined) dbUpdates.source_objects = updates.sourceObjects ?? null
  if (updates.sourceBytes !== undefined) dbUpdates.source_bytes = updates.sourceBytes ?? null

  let { data, error } = await supabase
    .from(MIGRATION_ITEMS_TABLE)
    .update(dbUpdates)
    .eq("id", id)
    .select("*")
    .single()

  if (error && isSlurperStatusColumnError(error) && "slurper_status" in dbUpdates) {
    // If PostgREST schema cache is stale (or the column truly doesn't exist),
    // keep the system running by retrying without touching `slurper_status`.
    delete dbUpdates.slurper_status
    ;({ data, error } = await supabase
      .from(MIGRATION_ITEMS_TABLE)
      .update(dbUpdates)
      .eq("id", id)
      .select("*")
      .single())
  }

  if (error) throw normalizeSupabaseError(error)
  return mapMigrationItemRow(data as DriveMigrationItemRow)
}

export async function mergeMigrationItemProgressState(
  id: string,
  patch: Record<string, unknown>,
  lastProgressAt?: string | null
): Promise<DriveMigrationItem> {
  const supabase = getSupabaseServerClient()
  const { data: currentRows, error: currentErr } = await supabase
    .from(MIGRATION_ITEMS_TABLE)
    .select("*")
    .eq("id", id)
    .limit(1)

  if (currentErr) throw normalizeSupabaseError(currentErr)
  const currentRow = Array.isArray(currentRows) ? (currentRows[0] as DriveMigrationItemRow | undefined) : undefined
  if (!currentRow) throw new Error("Migration item not found")

  const currentProgress =
    currentRow.progress && typeof currentRow.progress === "object" ? (currentRow.progress as Record<string, unknown>) : {}
  const nextProgress = { ...currentProgress, ...patch }
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from(MIGRATION_ITEMS_TABLE)
    .update({
      progress: nextProgress,
      updated_at: now,
      ...(lastProgressAt !== undefined ? { last_progress_at: lastProgressAt ?? null } : {}),
    })
    .eq("id", id)
    .select("*")
    .single()

  if (error) throw normalizeSupabaseError(error)
  return mapMigrationItemRow(data as DriveMigrationItemRow)
}

export async function claimMigrationItemJobCreation(input: {
  itemId: string
  progress: Record<string, unknown>
}): Promise<boolean> {
  const supabase = getSupabaseServerClient()

  const now = new Date().toISOString()
  const progress: Record<string, unknown> =
    input.progress && typeof input.progress === "object" ? (input.progress as Record<string, unknown>) : {}
  progress.slurperStatus = "creating_job"

  // Primary path: use `slurper_status` to block concurrent creators.
  let { data, error } = await supabase
    .from(MIGRATION_ITEMS_TABLE)
    .update({
      slurper_status: "creating_job",
      progress,
      last_progress_at: now,
      updated_at: now,
    })
    .eq("id", input.itemId)
    .is("slurper_job_id", null)
    // Allow NULL statuses, but block concurrent creators.
    .or("slurper_status.is.null,slurper_status.neq.creating_job")
    .or("slurper_status.is.null,slurper_status.neq.job_id_pending")
    .select("id")

  if (error && isSlurperStatusColumnError(error)) {
    // Fallback: if `slurper_status` is not visible (stale schema cache),
    // claim using a temporary job id marker instead.
    ;({ data, error } = await supabase
      .from(MIGRATION_ITEMS_TABLE)
      .update({
        slurper_job_id: "__creating_job__",
        progress,
        last_progress_at: now,
        updated_at: now,
      })
      .eq("id", input.itemId)
      .is("slurper_job_id", null)
      .select("id"))
  }

  if (error) throw normalizeSupabaseError(error)
  return Array.isArray(data) && data.length > 0
}
