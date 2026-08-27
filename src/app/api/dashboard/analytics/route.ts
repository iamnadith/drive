import { NextResponse } from "next/server"

import { getAllAccounts, type CloudflareAccount } from "@/lib/accounts-store"
import { listAgents, type DriveAgent, type DriveAgentRun } from "@/lib/agents-store"
import {
  listMigrations,
  type DriveMigration,
  type DriveMigrationItem,
} from "@/lib/migrations-store"
import { getMergedBucketSnapshot } from "@/lib/migration-bucket-state"
import { syncMigrationLiveState } from "@/lib/migration-live-state"
import { reconcileRepairJobs, type DriveRepairJob } from "@/lib/repair-jobs-store"
import { isPostgresConfigured, queryDb } from "@/lib/db"
import { getSupabaseServerClient } from "@/lib/supabase"
import { getAllUsers, type User } from "@/lib/users-store"
import { requireAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"

type RangeKey = "7d" | "30d" | "90d" | "all"

type BucketStatsRow = {
  id: string
  account_id: string
  bucket_name: string
  objects: number | string | null
  bytes: number | string | null
  status: string | null
  error: string | null
  updated_at: string | null
}

type MigrationItemRow = {
  id: string
  migration_id: string
  source_bucket: string
  target_bucket: string
  source_objects: number | string | null
  source_bytes: number | string | null
  slurper_job_id: string | null
  slurper_status: string | null
  progress: Record<string, unknown> | null
  last_progress_at: string | null
  created_at: string
  updated_at: string | null
}

type VerifyDiffRow = {
  id: string
  migration_item_id: string
  kind: string
  key: string
  created_at: string
}

type RepairJobRow = {
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

type BucketSnapshotRow = {
  account_id: string
  account_label: string | null
  account_email: string | null
  bucket_name: string
  objects: string | number | null
  bytes: string | number | null
  status: string | null
  source_updated_at: string | null
  captured_at: string
}

type ActiveAccountSnapshotRow = {
  captured_day: string
  account_id: string
  account_label: string | null
  account_email: string | null
  buckets: string | number | null
  objects: string | number | null
  bytes: string | number | null
  captured_at: string
}

function asRange(value: string | null): RangeKey {
  if (value === "7d" || value === "30d" || value === "90d") return value
  return "all"
}

function rangeDays(range: RangeKey): number | null {
  if (range === "all") return null
  if (range === "90d") return 90
  if (range === "30d") return 30
  return 7
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function dateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return new Date().toISOString().slice(0, 10)
  return date.toISOString().slice(0, 10)
}

function earliestDate(values: Array<string | undefined | null>): Date {
  const times = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter(Number.isFinite)
  if (times.length === 0) {
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    return today
  }
  const date = new Date(Math.min(...times))
  date.setUTCHours(0, 0, 0, 0)
  return date
}

function isRecentIso(value: string | undefined, maxAgeMs: number): boolean {
  if (!value) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && Date.now() - time <= maxAgeMs
}

function increment(map: Record<string, number>, key: string | undefined | null, by = 1) {
  const normalized = String(key || "unknown")
  map[normalized] = (map[normalized] ?? 0) + by
}

function getEffectiveAgentStatus(agent: DriveAgent & { latestRun: DriveAgentRun | null }): string {
  if (agent.provider === "github_actions") {
    if (isRecentIso(agent.lastHeartbeatAt, 90_000)) return "online"
    return agent.status === "online" || agent.status === "busy" ? "online" : "offline"
  }
  if (agent.status === "error") return "offline"
  if ((agent.provider === "self_hosted" || agent.provider === "local") && agent.status === "online") {
    if (!isRecentIso(agent.lastHeartbeatAt, 60_000)) return "offline"
  }
  return agent.status
}

function itemMetrics(item: DriveMigrationItem) {
  const snapshot = getMergedBucketSnapshot(item)
  return {
    totalObjects: snapshot.total || item.sourceObjects || 0,
    totalBytes: item.sourceBytes || 0,
    transferred: snapshot.transferred,
    skipped: snapshot.skipped,
    failed: snapshot.failed,
    verifyIssues: snapshot.verifyIssues,
  }
}

async function capture<T>(
  label: string,
  warnings: string[],
  fn: () => Promise<T>,
  fallback: T,
  options?: { reportWarning?: boolean }
): Promise<T> {
  try {
    return await fn()
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? label)
        : label
    if (options?.reportWarning === false) {
      console.warn(`[analytics] ${label}: ${message}`)
    } else {
      warnings.push(`${label}: ${message}`)
    }
    return fallback
  }
}

async function selectRows<T>(table: string, columns = "*", order?: { column: string; ascending?: boolean }, limit?: number) {
  const supabase = getSupabaseServerClient()
  let query = supabase.from(table).select(columns)
  if (order) query = query.order(order.column, { ascending: order.ascending ?? false })
  if (limit) query = query.limit(limit)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (Array.isArray(data) ? data : []) as T[]
}

async function countRows(table: string): Promise<number> {
  const supabase = getSupabaseServerClient()
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true })
  if (error) throw new Error(error.message)
  return count ?? 0
}

async function ensureAnalyticsArchiveSchema() {
  if (!isPostgresConfigured()) return
  await queryDb(`
    create table if not exists drive_analytics_bucket_snapshots (
      account_id uuid not null,
      account_label text,
      account_email text,
      bucket_name text not null,
      objects bigint not null default 0,
      bytes bigint not null default 0,
      status text,
      source_updated_at timestamptz,
      captured_at timestamptz not null default now(),
      primary key (account_id, bucket_name)
    );
  `)
  await queryDb(`create index if not exists drive_analytics_bucket_snapshots_captured_idx on drive_analytics_bucket_snapshots (captured_at desc);`)
  await queryDb(`
    create table if not exists drive_analytics_active_account_snapshots (
      captured_day date not null,
      account_id uuid not null,
      account_label text,
      account_email text,
      buckets integer not null default 0,
      objects bigint not null default 0,
      bytes bigint not null default 0,
      captured_at timestamptz not null default now(),
      primary key (captured_day, account_id)
    );
  `)
  await queryDb(`create index if not exists drive_analytics_active_account_snapshots_day_idx on drive_analytics_active_account_snapshots (captured_day desc);`)
}

async function archiveBucketStats(accounts: CloudflareAccount[], rows: BucketStatsRow[]) {
  if (!isPostgresConfigured() || rows.length === 0) return
  await ensureAnalyticsArchiveSchema()
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  const values: unknown[] = []
  const placeholders = rows
    .map((row, index) => {
      const account = accountById.get(row.account_id)
      const base = index * 8
      values.push(
        row.account_id,
        account?.label ?? null,
        account?.email ?? null,
        row.bucket_name,
        Math.max(0, Math.floor(toNumber(row.objects))),
        Math.max(0, Math.floor(toNumber(row.bytes))),
        row.status ?? null,
        row.updated_at ?? null
      )
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`
    })
    .join(",")

  await queryDb(
    `
      insert into drive_analytics_bucket_snapshots
        (account_id, account_label, account_email, bucket_name, objects, bytes, status, source_updated_at)
      values ${placeholders}
      on conflict (account_id, bucket_name) do update set
        account_label = excluded.account_label,
        account_email = excluded.account_email,
        objects = excluded.objects,
        bytes = excluded.bytes,
        status = excluded.status,
        source_updated_at = excluded.source_updated_at,
        captured_at = now()
      where drive_analytics_bucket_snapshots.account_label is distinct from excluded.account_label
         or drive_analytics_bucket_snapshots.account_email is distinct from excluded.account_email
         or drive_analytics_bucket_snapshots.objects is distinct from excluded.objects
         or drive_analytics_bucket_snapshots.bytes is distinct from excluded.bytes
         or drive_analytics_bucket_snapshots.status is distinct from excluded.status;
    `,
    values
  )
}

async function listBucketSnapshots(): Promise<BucketSnapshotRow[]> {
  if (!isPostgresConfigured()) return []
  await ensureAnalyticsArchiveSchema()
  const { rows } = await queryDb<BucketSnapshotRow>(`
    select account_id, account_label, account_email, bucket_name, objects, bytes, status, source_updated_at, captured_at
    from drive_analytics_bucket_snapshots
  `)
  return rows
}

async function captureActiveAccountSnapshot(input: {
  account: CloudflareAccount | null
  rows: BucketStatsRow[]
  generatedAt: string
  ready: boolean
}) {
  // Never publish a chart point from the worker's in-progress bucket batches.
  // Account totals are published only after the worker has completed every
  // bucket, so snapshots must use the same completion boundary.
  if (!isPostgresConfigured() || !input.account || !input.ready) return
  await ensureAnalyticsArchiveSchema()
  const capturedDay = input.generatedAt.slice(0, 10)
  const buckets = new Set(input.rows.map((row) => row.bucket_name)).size
  const objects = input.rows.reduce((sum, row) => sum + toNumber(row.objects), 0)
  const bytes = input.rows.reduce((sum, row) => sum + toNumber(row.bytes), 0)
  await queryDb(
    `
      with latest as (
        select buckets, objects, bytes
        from drive_analytics_active_account_snapshots
        where account_id = $2
        order by captured_at desc
        limit 1
      )
      insert into drive_analytics_active_account_snapshots
        (captured_day, account_id, account_label, account_email, buckets, objects, bytes, captured_at)
      select $1, $2, $3, $4, $5, $6, $7, $8
      where not exists (select 1 from latest)
         or exists (
           select 1 from latest
           where latest.buckets is distinct from $5
              or latest.objects is distinct from $6
              or latest.bytes is distinct from $7
         )
      on conflict (captured_day, account_id) do update set
        account_label = excluded.account_label,
        account_email = excluded.account_email,
        buckets = excluded.buckets,
        objects = excluded.objects,
        bytes = excluded.bytes,
        captured_at = excluded.captured_at;
    `,
    [
      capturedDay,
      input.account.id,
      input.account.label,
      input.account.email,
      buckets,
      Math.max(0, Math.floor(objects)),
      Math.max(0, Math.floor(bytes)),
      input.generatedAt,
    ]
  )
}

async function listActiveAccountSnapshots(): Promise<ActiveAccountSnapshotRow[]> {
  if (!isPostgresConfigured()) return []
  await ensureAnalyticsArchiveSchema()
  const { rows } = await queryDb<ActiveAccountSnapshotRow>(`
    select captured_day, account_id, account_label, account_email, buckets, objects, bytes, captured_at
    from (
      select distinct on (captured_day)
        captured_day::text as captured_day,
        account_id,
        account_label,
        account_email,
        buckets,
        objects,
        bytes,
        captured_at
      from drive_analytics_active_account_snapshots
      order by captured_day desc, captured_at desc
    ) daily
    order by captured_day desc
    limit 730
  `)
  return rows.reverse()
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), ms)
    promise
      .then((value) => resolve(value))
      .catch(() => resolve(null))
      .finally(() => clearTimeout(timeout))
  })
}

const ANALYTICS_CACHE_TTL_MS = 20_000
const ANALYTICS_RECONCILE_TTL_MS = 45_000
const ANALYTICS_REPAIR_RECONCILE_TTL_MS = 30_000

let lastAnalyticsReconcileAt = 0
let lastRepairReconcileAt = 0

const analyticsCache = new Map<RangeKey, { expiresAt: number; payload: unknown }>()
const analyticsInFlight = new Map<RangeKey, Promise<unknown>>()

function mapRepairJobRow(row: RepairJobRow): DriveRepairJob {
  const status = ["pending", "claimed", "running", "completed", "failed", "canceled"].includes(row.status)
    ? row.status
    : "pending"
  const mode = ["verify_only", "repair_only", "repair_and_verify"].includes(row.mode) ? row.mode : "repair_and_verify"
  return {
    id: row.id,
    migrationId: row.migration_id,
    requestedByAgentId: row.requested_by_agent_id ?? undefined,
    claimedByAgentId: row.claimed_by_agent_id ?? undefined,
    status: status as DriveRepairJob["status"],
    mode: mode as DriveRepairJob["mode"],
    payload: row.payload ?? {},
    progress: row.progress ?? {},
    result: row.result ?? {},
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

async function maybeReconcileAnalyticsState(migrations: DriveMigration[], warnings: string[]) {
  if (Date.now() - lastAnalyticsReconcileAt < ANALYTICS_RECONCILE_TTL_MS) return migrations

  lastAnalyticsReconcileAt = Date.now()
  const reconcileCandidates = migrations
    .filter((m) => m.status === "running" || m.status === "verifying" || m.syncStatus === "syncing")
    .slice(0, 5)

  if (reconcileCandidates.length === 0) return migrations

  await Promise.all(
    reconcileCandidates.map((migration) =>
      withTimeout(syncMigrationLiveState(migration.id), 4_000).catch((error: unknown) => {
        const message =
          typeof error === "object" && error !== null && "message" in error
            ? String((error as { message?: unknown }).message ?? "Unable to reconcile migration")
            : "Unable to reconcile migration"
        warnings.push(`migration ${migration.id}: ${message}`)
      })
    )
  )

  return capture("refreshed migrations", warnings, () => listMigrations(100), migrations)
}

function kickRepairJobReconcile() {
  if (Date.now() - lastRepairReconcileAt < ANALYTICS_REPAIR_RECONCILE_TTL_MS) return
  lastRepairReconcileAt = Date.now()
  void reconcileRepairJobs().catch(() => undefined)
}

async function buildAnalyticsPayload(range: RangeKey) {
  const days = rangeDays(range)
  const generatedAt = new Date().toISOString()
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  if (days === null) {
    start.setTime(0)
  } else {
    start.setUTCDate(start.getUTCDate() - (days - 1))
  }

  const warnings: string[] = []

  let migrations = await capture("migrations", warnings, () => listMigrations(100), [] as DriveMigration[])
  migrations = await maybeReconcileAnalyticsState(migrations, warnings)
  kickRepairJobReconcile()

  const [
    accounts,
    users,
    agents,
    repairJobs,
    bucketStats,
    migrationItemRows,
    recentDiffs,
    failureRecordCount,
    verifyDiffCount,
  ] =
    await Promise.all([
      capture("accounts", warnings, getAllAccounts, [] as CloudflareAccount[]),
      capture("users", warnings, getAllUsers, [] as User[]),
      capture("workers", warnings, listAgents, [] as Array<DriveAgent & { latestRun: DriveAgentRun | null }>),
      capture(
        "repair jobs",
        warnings,
        async () => {
          const rows = await selectRows<RepairJobRow>("drive_repair_jobs", "*", { column: "created_at", ascending: false }, 100)
          return rows.map(mapRepairJobRow)
        },
        [] as DriveRepairJob[]
      ),
      capture("bucket stats", warnings, () => selectRows<BucketStatsRow>("drive_bucket_stats"), [] as BucketStatsRow[]),
      capture("migration items", warnings, () => selectRows<MigrationItemRow>("drive_migration_items"), [] as MigrationItemRow[]),
      capture(
        "verification diffs",
        warnings,
        () =>
          selectRows<VerifyDiffRow>(
            "drive_bucket_verify_diffs",
            "id,migration_item_id,kind,key,created_at",
            { column: "created_at", ascending: false },
            25
        ),
        [] as VerifyDiffRow[]
      ),
      capture("failure record count", warnings, () => countRows("drive_migration_item_failure_records"), 0),
      capture("verification diff count", warnings, () => countRows("drive_bucket_verify_diffs"), 0),
    ])

  await capture("analytics archive write", warnings, () => archiveBucketStats(accounts, bucketStats), undefined, {
    reportWarning: false,
  })
  const archivedBucketStats = await capture(
    "analytics archive read",
    warnings,
    listBucketSnapshots,
    [] as BucketSnapshotRow[],
    { reportWarning: false }
  )

  const itemRowsAsItems: DriveMigrationItem[] = migrationItemRows.map((row) => ({
    id: row.id,
    migrationId: row.migration_id,
    sourceBucket: row.source_bucket,
    targetBucket: row.target_bucket,
    sourceObjects: toNumber(row.source_objects) || undefined,
    sourceBytes: toNumber(row.source_bytes) || undefined,
    slurperJobId: row.slurper_job_id ?? undefined,
    slurperStatus: row.slurper_status ?? undefined,
    progress: row.progress ?? {},
    lastProgressAt: row.last_progress_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  }))

  const accountById = new Map(accounts.map((account) => [account.id, account]))

  const migrationBreakdown: Record<string, number> = {}
  for (const migration of migrations) increment(migrationBreakdown, migration.status)

  const accountBreakdown: Record<string, number> = {}
  for (const account of accounts) increment(accountBreakdown, account.status)

  const workerBreakdown: Record<string, number> = {}
  for (const agent of agents) increment(workerBreakdown, getEffectiveAgentStatus(agent))

  const repairBreakdown: Record<string, number> = {}
  for (const job of repairJobs) increment(repairBreakdown, job.status)

  const bucketSyncBreakdown: Record<string, number> = {}
  for (const row of bucketStats) increment(bucketSyncBreakdown, row.status)

  const totalsByMigration = new Map<string, ReturnType<typeof itemMetrics>>()
  for (const item of itemRowsAsItems) {
    const metrics = itemMetrics(item)
    const current = totalsByMigration.get(item.migrationId) ?? {
      totalObjects: 0,
      totalBytes: 0,
      transferred: 0,
      skipped: 0,
      failed: 0,
      verifyIssues: 0,
    }
    totalsByMigration.set(item.migrationId, {
      totalObjects: current.totalObjects + metrics.totalObjects,
      totalBytes: current.totalBytes + metrics.totalBytes,
      transferred: current.transferred + metrics.transferred,
      skipped: current.skipped + metrics.skipped,
      failed: current.failed + metrics.failed,
      verifyIssues: current.verifyIssues + metrics.verifyIssues,
    })
  }

  const activeAccount = accounts.find((account) => account.status === "active") ?? null
  const activeBucketStats = activeAccount
    ? bucketStats.filter((row) => row.account_id === activeAccount.id)
    : []
  const currentBucketKeys = new Set(bucketStats.map((row) => `${row.account_id}:${row.bucket_name}`))
  const archivedDeletedBucketStats: BucketStatsRow[] = archivedBucketStats
    .filter((row) => !currentBucketKeys.has(`${row.account_id}:${row.bucket_name}`))
    .map((row) => ({
      id: `${row.account_id}:${row.bucket_name}`,
      account_id: row.account_id,
      bucket_name: row.bucket_name,
      objects: row.objects,
      bytes: row.bytes,
      status: row.status,
      error: null,
      updated_at: row.source_updated_at ?? row.captured_at,
    }))
  const analyticsBucketStats = [...bucketStats, ...archivedDeletedBucketStats]
  const activeAnalyticsBucketStats = activeAccount
    ? analyticsBucketStats.filter((row) => row.account_id === activeAccount.id)
    : []
  const activeBucketStatsReady = Boolean(
    activeAccount &&
      activeAccount.syncStatus === "ok" &&
      (activeBucketStats.length === 0 ||
        activeBucketStats.every((row) => String(row.status ?? "").toLowerCase() === "completed"))
  )
  await capture(
    "active account analytics snapshot write",
    warnings,
    () =>
      captureActiveAccountSnapshot({
        account: activeAccount,
        rows: activeBucketStats,
        generatedAt,
        ready: activeBucketStatsReady,
      }),
    undefined
  )
  const activeAccountSnapshotRows = await capture(
    "active account analytics snapshots",
    warnings,
    listActiveAccountSnapshots,
    [] as ActiveAccountSnapshotRow[]
  )
  const currentActiveAccountSnapshotRows = activeAccount
    ? activeAccountSnapshotRows.filter((row) => row.account_id === activeAccount.id)
    : []
  const archivedAccountLabelById = new Map(
    archivedBucketStats.map((row) => [
      row.account_id,
      row.account_label || row.account_email || "Deleted account",
    ])
  )
  const chartStart =
    range === "all"
      ? earliestDate([
          ...activeAnalyticsBucketStats.map((row) => row.updated_at),
          ...currentActiveAccountSnapshotRows.map((row) => row.captured_day),
          ...migrations.map((migration) => migration.createdAt),
          ...migrations.map((migration) => migration.completedAt),
          ...itemRowsAsItems.map((item) => item.lastProgressAt || item.updatedAt || item.createdAt),
          ...repairJobs.map((job) => job.updatedAt || job.createdAt),
        ])
      : start
  const chartDays = Math.max(
    1,
    Math.floor((new Date(new Date().toISOString().slice(0, 10)).getTime() - chartStart.getTime()) / 86_400_000) + 1
  )

  const dayKeys = Array.from({ length: chartDays }, (_, index) => {
    const date = new Date(chartStart)
    date.setUTCDate(chartStart.getUTCDate() + index)
    return dateKey(date)
  })

  const legacyStorageSeries =
    currentActiveAccountSnapshotRows.length > 0
      ? currentActiveAccountSnapshotRows.map((row) => ({
          date: row.captured_day,
          accountId: row.account_id,
          accountLabel: row.account_label || row.account_email || "Unknown account",
          buckets: toNumber(row.buckets),
          storageBytes: toNumber(row.bytes),
          objects: toNumber(row.objects),
          capturedAt: row.captured_at,
        }))
      : activeAccount
        ? [
            {
              date: generatedAt.slice(0, 10),
              accountId: activeAccount.id,
              accountLabel: activeAccount.label || activeAccount.email,
              buckets: new Set(activeAnalyticsBucketStats.map((row) => row.bucket_name)).size,
              storageBytes: activeAnalyticsBucketStats.reduce((sum, row) => sum + toNumber(row.bytes), 0),
              objects: activeAnalyticsBucketStats.reduce((sum, row) => sum + toNumber(row.objects), 0),
              capturedAt: generatedAt,
            },
          ]
        : []
  const storageSeriesByDay = new Map(legacyStorageSeries.map((point) => [point.date, point]))
  const activeAccountSeries = Array.from(storageSeriesByDay.values()).sort((a, b) => a.date.localeCompare(b.date))

  const series = dayKeys.map((day) => {
    const dayEnd = Date.parse(`${day}T23:59:59.999Z`)
    const logicalStoragePoint = [...activeAccountSeries].reverse().find((point) => point.date <= day)
    const storageBytes = logicalStoragePoint?.storageBytes ?? 0
    const objects = logicalStoragePoint?.objects ?? 0
    const createdMigrations = migrations.filter((m) => dateKey(m.createdAt) === day).length
    const completedMigrations = migrations.filter((m) => m.completedAt && dateKey(m.completedAt) === day).length
    const knownItems = itemRowsAsItems.filter((item) => {
      const anchor = item.lastProgressAt || item.updatedAt || item.createdAt
      const updatedAt = anchor ? Date.parse(anchor) : Number.NaN
      return Number.isFinite(updatedAt) && updatedAt <= dayEnd
    })
    const transfer = knownItems.reduce(
      (sum, item) => {
        const metrics = itemMetrics(item)
        return {
          transferred: sum.transferred + metrics.transferred,
          failed: sum.failed + metrics.failed,
          verifyIssues: sum.verifyIssues + metrics.verifyIssues,
        }
      },
      { transferred: 0, failed: 0, verifyIssues: 0 }
    )
    const activeRepairs = repairJobs.filter((job) => {
      const anchor = job.updatedAt || job.createdAt
      return anchor && dateKey(anchor) === day && ["pending", "claimed", "running"].includes(job.status)
    }).length
    return {
      date: day,
      storageBytes,
      objects,
      createdMigrations,
      completedMigrations,
      transferredObjects: transfer.transferred,
      failedObjects: transfer.failed,
      verifyIssues: transfer.verifyIssues,
      activeRepairs,
    }
  })
  const dailyStorageSeries = series.map((point) => {
    const source = [...activeAccountSeries].reverse().find((item) => item.date <= point.date)
    return {
      date: point.date,
      accountId: source?.accountId ?? "logical-storage",
      accountLabel: source?.accountLabel ?? "Logical storage",
      buckets: source?.buckets ?? 0,
      storageBytes: point.storageBytes,
      objects: point.objects,
      capturedAt: source?.capturedAt ?? generatedAt,
    }
  })

  // The worker publishes account totals only after all bucket batches finish.
  // Do not sum partially updated bucket rows while sync_status is syncing.
  const totalStorageBytes = activeAccount?.totalBytes ?? 0
  const totalObjects = activeAccount?.totalObjects ?? 0
  const migrationNeedsAttention = (migration: DriveMigration) =>
    migration.status === "failed" ||
    (migration.syncStatus === "error" && migration.status !== "completed" && migration.status !== "canceled")

  const failedMigrationCount = migrations.filter(migrationNeedsAttention).length
  const activeMigrationCount = migrations.filter((m) => m.status === "running" || m.status === "verifying").length
  const failedRepairCount = repairJobs.filter((job) => job.status === "failed").length
  const activeRepairCount = repairJobs.filter((job) => ["pending", "claimed", "running"].includes(job.status)).length
  const failedBucketStats = bucketStats.filter((row) => row.status === "error").length
  const onlineWorkers = agents.filter((agent) => getEffectiveAgentStatus(agent) === "online").length
  const topBuckets = activeAnalyticsBucketStats
    .map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountLabel: accountById.get(row.account_id)?.label ?? archivedAccountLabelById.get(row.account_id) ?? "Unknown account",
      name: row.bucket_name,
      objects: toNumber(row.objects),
      bytes: toNumber(row.bytes),
      status: row.status ?? "unknown",
      error: row.error ?? undefined,
      updatedAt: row.updated_at ?? undefined,
    }))
    .sort((a, b) => b.bytes - a.bytes || b.objects - a.objects)

  const attentionItems = [
    ...migrations
      .filter(migrationNeedsAttention)
      .map((m) => ({
        id: `migration-${m.id}`,
        severity: "critical",
        title: m.status === "failed" ? "Migration failed" : "Migration sync issue",
        detail: m.syncMessage || `Migration ${m.id} needs attention`,
        href: `/dashboard/migrations/${m.id}`,
        at: m.updatedAt || m.completedAt || m.createdAt,
      })),
    ...repairJobs
      .filter((job) => job.status === "failed")
      .map((job) => ({
        id: `repair-${job.id}`,
        severity: "critical",
        title: "Worker job failed",
        detail: job.error || job.summary || `Repair job ${job.id} failed`,
        href: `/dashboard/workers/jobs/${job.id}`,
        at: job.updatedAt || job.completedAt || job.createdAt,
      })),
    ...bucketStats
      .filter((row) => row.status === "error")
      .map((row) => ({
        id: `bucket-${row.id}`,
        severity: "warning",
        title: "Bucket stats error",
        detail: `${row.bucket_name}: ${row.error || "Unable to sync bucket stats"}`,
        href: "/dashboard/storage",
        at: row.updated_at || generatedAt,
      })),
    ...accounts
      .filter((account) => account.syncStatus === "error" || !account.cloudflareAccountId)
      .map((account) => ({
        id: `account-${account.id}`,
        severity: account.syncStatus === "error" ? "critical" : "warning",
        title: "Account sync issue",
        detail: account.syncMessage || `${account.label} is not fully synced`,
        href: "/dashboard/accounts",
        at: account.lastSyncedAt || account.createdAt,
      })),
    ...recentDiffs.map((diff) => ({
      id: `diff-${diff.id}`,
      severity: "warning",
      title: `Verification ${diff.kind.replaceAll("_", " ")}`,
      detail: diff.key,
      href: "/dashboard/migrations/history",
      at: diff.created_at,
    })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 10)

  const newestBucketStat = activeBucketStats
    .map((row) => (row.updated_at ? Date.parse(row.updated_at) : Number.NaN))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0]
  const activeBucketStatsIncomplete =
    Boolean(activeAccount) &&
    (activeBucketStats.length === 0 ||
      activeBucketStats.some((row) => {
        const status = String(row.status ?? "").toLowerCase()
        return status === "pending" || status === "running" || status === "error"
      }))
  const staleBucketStats =
    activeBucketStatsIncomplete ||
    (Boolean(activeAccount) && activeBucketStats.length > 0 && !Number.isFinite(newestBucketStat))

  return {
    range,
    generatedAt,
    activeAccount: activeAccount
      ? {
          id: activeAccount.id,
          label: activeAccount.label,
          email: activeAccount.email,
          status: activeAccount.status,
          lastSyncedAt: activeAccount.lastSyncedAt,
          syncStatus: activeAccount.syncStatus,
        }
      : null,
    metrics: {
      storageBytes: totalStorageBytes,
      objects: totalObjects,
      buckets: new Set(activeAnalyticsBucketStats.map((row) => `${row.account_id}:${row.bucket_name}`)).size,
      accounts: accounts.length,
      activeAccounts: accounts.filter((account) => account.status === "active").length,
      users: users.length,
      activeUsers: users.filter((user) => user.status === "active").length,
      migrations: migrations.length,
      activeMigrations: activeMigrationCount,
      failedMigrations: failedMigrationCount,
      workers: agents.length,
      onlineWorkers,
      repairJobs: repairJobs.length,
      activeRepairJobs: activeRepairCount,
      failedRepairJobs: failedRepairCount,
      failureRecords: failureRecordCount,
      verificationDiffs: verifyDiffCount,
      attentionItems: failedMigrationCount + failedRepairCount + failedBucketStats + failureRecordCount + verifyDiffCount,
    },
    series,
    activeAccountSeries: dailyStorageSeries,
    breakdowns: {
      migrations: migrationBreakdown,
      accounts: accountBreakdown,
      workers: workerBreakdown,
      repairs: repairBreakdown,
      bucketStats: bucketSyncBreakdown,
    },
    topBuckets,
    attentionItems,
    syncHealth: {
      partial: warnings.length > 0,
      warnings,
      staleBucketStats,
      bucketStatsUpdatedAt: Number.isFinite(newestBucketStat) ? new Date(newestBucketStat).toISOString() : null,
      unsyncedAccounts: accounts.filter((account) => !account.cloudflareAccountId).length,
      accountSyncErrors: accounts.filter((account) => account.syncStatus === "error").length,
      bucketStatsErrors: failedBucketStats,
    },
  }
}

function queueAnalyticsPayload(range: RangeKey): Promise<unknown> {
  const existing = analyticsInFlight.get(range)
  if (existing) return existing

  const promise = buildAnalyticsPayload(range)
    .then((payload) => {
      analyticsCache.set(range, {
        expiresAt: Date.now() + ANALYTICS_CACHE_TTL_MS,
        payload,
      })
      return payload
    })
    .finally(() => {
      analyticsInFlight.delete(range)
    })

  analyticsInFlight.set(range, promise)
  return promise
}

export async function GET(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  const url = new URL(request.url)
  const range = asRange(url.searchParams.get("range"))
  const forceRefresh = url.searchParams.get("refresh") === "1"
  const cached = analyticsCache.get(range)

  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.payload)
  }

  // An expired payload is known to be stale. Await the rebuild so account
  // deletion and worker completion cannot leave the dashboard showing the old
  // account or a partial bucket batch for another refresh cycle.

  const payload = await queueAnalyticsPayload(range)
  return NextResponse.json(payload)
}
