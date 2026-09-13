import { NextResponse } from "next/server"
import { getAllAccounts, getActiveAccount, listDashboardAccountSummaries } from "@/lib/accounts-store"
import { r2ListBuckets } from "@/lib/cloudflare-r2-buckets"
import { createMigration, listMigrationItems, listMigrations } from "@/lib/migrations-store"
import { getBucketStatsMap, listActiveBucketStats } from "@/lib/bucket-stats-store"
import { requireAdmin } from "@/lib/server-auth"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function jsonOk(data: unknown) {
  return NextResponse.json(data, { status: 200 })
}

function jsonBad(error: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...(extra ?? {}) }, { status })
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    // Return only the account fields this page needs; never serialize account
    // credentials into its bootstrap payload. Bucket and migration data are
    // read from the worker/orchestrator-owned PostgreSQL projections.
    const [migrations, accounts, bucketStats] = await Promise.all([
      listMigrations(),
      listDashboardAccountSummaries().catch(() => []),
      listActiveBucketStats().then((rows) => ({ rows, error: null as string | null })).catch((error: unknown) => ({
        rows: [],
        error: error instanceof Error ? error.message : "Unable to load bucket statistics",
      })),
    ])
    const current =
      migrations.find((migration) => migration.status === "running") ??
      migrations.find((migration) => migration.status === "verifying") ??
      migrations.find((migration) => migration.status === "draft") ??
      migrations[0] ??
      null
    const activeItems = current ? await listMigrationItems(current.id).catch(() => []) : []
    const activeAccount = accounts.find((account) => account.status === "active")
    const bucketError = bucketStats.error ?? (
      !activeAccount
        ? "No active Cloudflare account"
        : !activeAccount.cloudflareAccountId
          ? "Active Cloudflare account is not synced. Sync the account first to list buckets."
          : null
    )
    return jsonOk({
      migrations,
      accounts: accounts.map(({ id, label, email, status }) => ({ id, label, email, status })),
      buckets: activeAccount?.cloudflareAccountId ? bucketStats.rows.map((row) => ({
        id: row.bucketName,
        name: row.bucketName,
        objects: row.objects,
        bytes: row.bytes,
        statsStatus: row.status,
        statsError: row.error,
        updatedAt: row.updatedAt,
      })) : [],
      bucketError,
      activeItems,
    })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unable to load migrations")
        : "Unable to load migrations"
    return jsonBad(message)
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const body: unknown = await request.json().catch(() => ({}))
    const data = isRecord(body) ? body : {}

    const targetAccountId =
      typeof data.targetAccountId === "string" ? data.targetAccountId : ""
    const overwrite = typeof data.overwrite === "boolean" ? data.overwrite : true
    const concurrency = typeof data.concurrency === "number" ? data.concurrency : 3
    const rawIncludeBuckets = data.includeBuckets
    const hasIncludeBuckets = Array.isArray(rawIncludeBuckets)
    const includeBuckets = hasIncludeBuckets
      ? rawIncludeBuckets.map((v) => String(v)).filter(Boolean)
      : undefined
    const rawExcludeBuckets = data.excludeBuckets
    const excludeBuckets = Array.isArray(rawExcludeBuckets)
      ? rawExcludeBuckets.map((v) => String(v)).filter(Boolean)
      : undefined
    const pathPrefix =
      typeof data.pathPrefix === "string"
        ? data.pathPrefix
        : data.pathPrefix === null
          ? null
          : undefined
    const verifyAfterCopy = typeof data.verifyAfterCopy === "boolean" ? data.verifyAfterCopy : true
    const verifyStrictDestination =
      typeof data.verifyStrictDestination === "boolean" ? data.verifyStrictDestination : false
    const verifyModeRaw = typeof data.verifyMode === "string" ? data.verifyMode : ""
    const verifyMode =
      verifyModeRaw === "sha256-small" || verifyModeRaw === "keys-and-size" ? verifyModeRaw : "keys-and-size"
    const verifyHashMaxBytes =
      typeof data.verifyHashMaxBytes === "number" && Number.isFinite(data.verifyHashMaxBytes)
        ? Math.max(0, Math.floor(data.verifyHashMaxBytes))
        : undefined
    const executionMode = data.executionMode === "migration_workers" ? "migration_workers" : "super_slurper"
    const workerShardCount =
      typeof data.workerShardCount === "number" && Number.isFinite(data.workerShardCount)
        ? Math.max(1, Math.min(128, Math.floor(data.workerShardCount)))
        : 32

    if (!targetAccountId) return jsonBad("targetAccountId is required")

    const source = await getActiveAccount()
    if (!source) return jsonBad("No active Cloudflare account")
    const accounts = await getAllAccounts()
    const target = accounts.find((a) => a.id === targetAccountId)
    if (!target) return jsonBad("Target Cloudflare account not found", 404)

    if (hasIncludeBuckets && includeBuckets?.length === 0) {
      const { migration, items } = await createMigration({
        sourceAccountId: source.id,
        targetAccountId: target.id,
        options: {
          overwrite,
          concurrency,
          includeBuckets,
          excludeBuckets,
          pathPrefix,
          sourceMode: "s3",
          executionMode,
          ...(executionMode === "migration_workers" ? { workerGeneration: 1, workerShardCount } : {}),
          verifyAfterCopy,
          verifyStrictDestination,
          verifyMode,
          ...(typeof verifyHashMaxBytes !== "undefined" ? { verifyHashMaxBytes } : {}),
        },
        items: [],
      })

      return jsonOk({ migration, items })
    }

    if (!source.cloudflareAccountId) return jsonBad("Active Cloudflare account is not synced")
    if (!target.cloudflareAccountId) return jsonBad("Target Cloudflare account is not synced")

    if (!source.r2AccessKeyId || !source.r2SecretAccessKey) {
      return jsonBad("Active Cloudflare account is missing R2 access keys")
    }
    if (!target.r2AccessKeyId || !target.r2SecretAccessKey) {
      return jsonBad("Target Cloudflare account is missing R2 access keys")
    }

    const buckets = await r2ListBuckets({
      accountId: source.cloudflareAccountId,
      apiToken: source.apiToken,
    })

    const filtered = buckets.filter((bucket) => {
      if (hasIncludeBuckets) return includeBuckets?.includes(bucket.name) ?? false
      if (excludeBuckets?.length) return !excludeBuckets.includes(bucket.name)
      return true
    })

    const cachedStats = await getBucketStatsMap(source.id)

    const { migration, items } = await createMigration({
      sourceAccountId: source.id,
      targetAccountId: target.id,
      // Both engines use the same account and bucket snapshot. The worker lane
      // copies through the durable queue; the Super Slurper path remains the
      // default and is unchanged.
      options: {
        overwrite,
        concurrency,
        includeBuckets,
        excludeBuckets,
        pathPrefix,
        sourceMode: "s3",
        executionMode,
        ...(executionMode === "migration_workers" ? { workerGeneration: 1, workerShardCount } : {}),
        verifyAfterCopy,
        verifyStrictDestination,
        verifyMode,
        ...(typeof verifyHashMaxBytes !== "undefined" ? { verifyHashMaxBytes } : {}),
      },
      items: filtered.map((bucket) => ({
        sourceBucket: bucket.name,
        targetBucket: bucket.name,
        sourceJurisdiction: bucket.jurisdiction,
        sourceStorageClass: bucket.storage_class,
        sourceObjects:
          cachedStats.get(bucket.name)?.status === "completed"
            ? cachedStats.get(bucket.name)!.objects
            : bucket.objects,
        sourceBytes:
          cachedStats.get(bucket.name)?.status === "completed"
            ? cachedStats.get(bucket.name)!.bytes
            : bucket.size,
      })),
    })

    return jsonOk({ migration, items })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unable to create migration")
        : "Unable to create migration"
    return jsonBad(message)
  }
}
