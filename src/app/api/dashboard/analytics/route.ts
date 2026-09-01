import { NextResponse } from "next/server"

import { getAllAccounts } from "@/lib/accounts-store"
import { listAgents, type DriveAgent, type DriveAgentRun } from "@/lib/agents-store"
import {
  listMigrations,
  type DriveMigration,
  type DriveMigrationItem,
} from "@/lib/migrations-store"
import { getMergedBucketSnapshot } from "@/lib/migration-bucket-state"
import { type DriveRepairJob } from "@/lib/repair-jobs-store"
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

async function listActiveAccountSnapshots(): Promise<ActiveAccountSnapshotRow[]> {
  if (!isPostgresConfigured()) return []
  const { rows } = await queryDb<ActiveAccountSnapshotRow>(`
    select captured_day, account_id, account_label, account_email, buckets, objects, bytes, captured_at
    from (
      select
        captured_day::text as captured_day,
        account_id,
        account_label,
        account_email,
        buckets,
        objects,
        bytes,
        captured_at
      from drive_analytics_active_account_snapshots
      order by captured_day desc
      limit 730
    ) daily
    order by captured_day asc
  `)
  return rows
}

const ANALYTICS_CACHE_TTL_MS = 20_000

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

  const migrations = await capture("migrations", warnings, () => listMigrations(100), [] as DriveMigration[])

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
      // Current-account identity and bucket totals are critical. If either
      // read fails, reject the refresh so the client retains its last known
      // payload instead of replacing current KPIs with misleading zeros.
      getAllAccounts(),
      capture("users", warnings, getAllUsers, [] as User[]),
      capture("workers", warnings, listAgents, [] as Array<DriveAgent & { latestRun: DriveAgentRun | null }>),
      capture(
        "repair jobs",
        warnings,
        async () => {
          const rows = await selectRows<RepairJobRow>(
            "drive_repair_jobs",
            "id,migration_id,requested_by_agent_id,claimed_by_agent_id,status,mode,payload,progress,result,summary,error,claimed_at,started_at,completed_at,last_heartbeat_at,created_at,updated_at",
            { column: "created_at", ascending: false },
            100
          )
          return rows.map(mapRepairJobRow)
        },
        [] as DriveRepairJob[]
      ),
      selectRows<BucketStatsRow>(
        "drive_bucket_stats",
        "id,account_id,bucket_name,objects,bytes,status,error,updated_at"
      ),
      capture(
        "migration items",
        warnings,
        () =>
          selectRows<MigrationItemRow>(
            "drive_migration_items",
            "id,migration_id,source_bucket,target_bucket,source_objects,source_bytes,slurper_job_id,slurper_status,progress,last_progress_at,created_at,updated_at"
          ),
        [] as MigrationItemRow[]
      ),
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
  const activeAnalyticsBucketStats = activeAccount
    ? bucketStats.filter((row) => row.account_id === activeAccount.id)
    : []
  const activeAccountSnapshotRows = await capture(
    "active account snapshots",
    warnings,
    listActiveAccountSnapshots,
    [] as ActiveAccountSnapshotRow[]
  )
  const chartStart =
    range === "all"
      ? earliestDate([
          ...activeAnalyticsBucketStats.map((row) => row.updated_at),
          ...activeAccountSnapshotRows.map((row) => row.captured_day),
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

  // Build the chart from persisted daily snapshots, selecting the latest
  // snapshot for each day regardless of which account is active now. Account
  // activation changes the current projection, but it must not rewrite the
  // historical chart or make it jump back to an older logical snapshot.
  const activeHistoryByDay = new Map<string, ActiveAccountSnapshotRow>()
  for (const row of activeAccountSnapshotRows) {
    const previous = activeHistoryByDay.get(row.captured_day)
    if (!previous || Date.parse(row.captured_at) >= Date.parse(previous.captured_at)) {
      activeHistoryByDay.set(row.captured_day, row)
    }
  }
  const activeHistorySeries = [...activeHistoryByDay.values()]
    .sort((a, b) => a.captured_day.localeCompare(b.captured_day))
    .map((row) => ({
      date: row.captured_day,
      accountId: row.account_id,
      accountLabel: row.account_label || row.account_email || "Unknown account",
      buckets: toNumber(row.buckets),
      storageBytes: toNumber(row.bytes),
      objects: toNumber(row.objects),
      capturedAt: row.captured_at,
    }))
  const legacyStorageSeries =
    activeHistorySeries.length > 0
      ? activeHistorySeries
      : activeAnalyticsBucketStats.length > 0
        ? [
            {
              date: generatedAt.slice(0, 10),
              accountId: activeAccount?.id ?? "active-account",
              accountLabel: activeAccount?.label || activeAccount?.email || "Active account",
              buckets: new Set(activeAnalyticsBucketStats.map((row) => row.bucket_name)).size,
              storageBytes: activeAnalyticsBucketStats.reduce((sum, row) => sum + toNumber(row.bytes), 0),
              objects: activeAnalyticsBucketStats.reduce((sum, row) => sum + toNumber(row.objects), 0),
              capturedAt: generatedAt,
            },
          ]
        : []
  const storageSeriesByDay = new Map(legacyStorageSeries.map((point) => [point.date, point]))
  const activeAccountSeries = Array.from(storageSeriesByDay.values()).sort((a, b) => a.date.localeCompare(b.date))

  // Walk the sparse storage snapshots once. Each snapshot remains effective
  // until the next change; dates before the first snapshot are explicitly
  // marked unknown so fixed chart ranges can render them as zero without
  // confusing them with a real zero-value snapshot.
  const logicalStorageByDay = new Map<string, (typeof activeAccountSeries)[number] | undefined>()
  let logicalStorageIndex = -1
  const series = dayKeys.map((day) => {
    const dayEnd = Date.parse(`${day}T23:59:59.999Z`)
    while (
      logicalStorageIndex + 1 < activeAccountSeries.length &&
      activeAccountSeries[logicalStorageIndex + 1].date <= day
    ) {
      logicalStorageIndex += 1
    }
    const logicalStoragePoint =
      logicalStorageIndex >= 0 ? activeAccountSeries[logicalStorageIndex] : undefined
    logicalStorageByDay.set(day, logicalStoragePoint)
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
    const source = logicalStorageByDay.get(point.date)
    return {
      date: point.date,
      accountId: source?.accountId ?? "logical-storage",
      accountLabel: source?.accountLabel ?? "Logical storage",
      buckets: source?.buckets ?? 0,
      storageBytes: point.storageBytes,
      objects: point.objects,
      capturedAt: source?.capturedAt ?? generatedAt,
      hasSnapshot: Boolean(source),
    }
  })

  // Current KPIs are strictly active-account scoped. Historical chart data,
  // archived rows, and disabled accounts must never be used as current values.
  const activeAggregateReady = activeAccount?.syncStatus === "ok"
  const activeBucketCount = new Set(activeBucketStats.map((row) => row.bucket_name)).size
  const activeBucketObjects = activeBucketStats.reduce((sum, row) => sum + toNumber(row.objects), 0)
  const activeBucketBytes = activeBucketStats.reduce((sum, row) => sum + toNumber(row.bytes), 0)
  const totalStorageBytes = activeAccount
    ? Math.max(0, activeAggregateReady ? toNumber(activeAccount.totalBytes) : activeBucketBytes)
    : 0
  const totalObjects = activeAccount
    ? Math.max(0, activeAggregateReady ? toNumber(activeAccount.totalObjects) : activeBucketObjects)
    : 0
  const totalBuckets = activeAccount
    ? Math.max(0, activeAggregateReady ? toNumber(activeAccount.totalBuckets) : activeBucketCount)
    : 0
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
      accountLabel: accountById.get(row.account_id)?.label ?? "Unknown account",
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
      buckets: totalBuckets,
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
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const url = new URL(request.url)
    const range = asRange(url.searchParams.get("range"))
    const forceRefresh = url.searchParams.get("refresh") === "1"
    const cached = analyticsCache.get(range)

    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return NextResponse.json(cached.payload)
    }

    const payload = await queueAnalyticsPayload(range)
    return NextResponse.json(payload)
  } catch (error: unknown) {
    console.error("[analytics] dashboard refresh failed", error)
    const message = error instanceof Error ? error.message : "Unable to read dashboard data"
    return NextResponse.json(
      { error: `Dashboard data is temporarily unavailable: ${message}` },
      { status: 503 }
    )
  }
}
