import { NextResponse } from "next/server"
import { getAllAccounts, getActiveAccount } from "@/lib/accounts-store"
import { r2ListBuckets } from "@/lib/cloudflare-r2-buckets"
import { createMigration, listMigrations } from "@/lib/migrations-store"
import { getBucketStatsMap } from "@/lib/bucket-stats-store"
import { syncMigrationLiveState } from "@/lib/migration-live-state"
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

    const migrations = await listMigrations()

    const candidates = migrations
      .filter((m) => m.status !== "draft" && m.status !== "canceled")
      .slice(0, 20)
    await Promise.all(candidates.map((migration) => syncMigrationLiveState(migration.id).catch(() => undefined)))

    const refreshed = await listMigrations()
    return jsonOk({ migrations: refreshed })
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
    const includeBuckets = Array.isArray(data.includeBuckets)
      ? data.includeBuckets.map((v) => String(v)).filter(Boolean)
      : undefined
    const excludeBuckets = Array.isArray(data.excludeBuckets)
      ? data.excludeBuckets.map((v) => String(v)).filter(Boolean)
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

    if (!targetAccountId) return jsonBad("targetAccountId is required")

    const source = await getActiveAccount()
    if (!source) return jsonBad("No active Cloudflare account")
    const accounts = await getAllAccounts()
    const target = accounts.find((a) => a.id === targetAccountId)
    if (!target) return jsonBad("Target Cloudflare account not found", 404)

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
      if (includeBuckets?.length) return includeBuckets.includes(bucket.name)
      if (excludeBuckets?.length) return !excludeBuckets.includes(bucket.name)
      return true
    })

    if (filtered.length === 0) {
      return jsonBad("No buckets to migrate (check include/exclude filters)")
    }

    const cachedStats = await getBucketStatsMap(source.id)

    const { migration, items } = await createMigration({
      sourceAccountId: source.id,
      targetAccountId: target.id,
      // Cross-account migrations must use Super Slurper with the S3-compatible source.
      options: {
        overwrite,
        concurrency,
        includeBuckets,
        excludeBuckets,
        pathPrefix,
        sourceMode: "s3",
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
