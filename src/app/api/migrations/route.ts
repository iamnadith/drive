import { NextResponse } from "next/server"
import { getAllAccounts, getActiveAccount } from "@/lib/accounts-store"
import { r2ListBuckets } from "@/lib/cloudflare-r2-buckets"
import { createMigration, listMigrationItems, listMigrations, updateMigration } from "@/lib/migrations-store"
import { getBucketStatsMap } from "@/lib/bucket-stats-store"
import { readBucketVerifyState } from "@/lib/bucket-verifier"

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
    const migrations = await listMigrations()

    // Best-effort reconciliation: prevent stale "running" migrations from sticking in history
    // when all items are terminal (including legacy copy_* statuses from older versions).
    const failedLike = (s: string) =>
      s.includes("failed") || s.includes("error") || s.endsWith("_failed") || s === "copy_failed"
    const isLegacyCopy = (s: string) => s.startsWith("copy_")
    const isTerminal = (s: string | undefined) => {
      const status = String(s ?? "").toLowerCase()
      return (
        status === "completed" ||
        status === "copy_completed" ||
        status === "complete" ||
        status === "finished" ||
        status === "success" ||
        status === "succeeded" ||
        status === "aborted" ||
        status === "canceled" ||
        status === "cancelled" ||
        status === "copy_aborted" ||
        isLegacyCopy(status) ||
        failedLike(status)
      )
    }
    const isSuccess = (s: string | undefined) => {
      const status = String(s ?? "").toLowerCase()
      return (
        status === "completed" ||
        status === "copy_completed" ||
        status === "complete" ||
        status === "finished" ||
        status === "success" ||
        status === "succeeded"
      )
    }
    const isVerifiedOk = (progress: Record<string, unknown>) => readBucketVerifyState(progress)?.status === "ok"

    const candidates = migrations
      .filter((m) => m.status === "running" || m.status === "verifying" || m.status === "completed")
      .slice(0, 10)
    for (const m of candidates) {
      const items = await listMigrationItems(m.id).catch(() => [])
      if (items.length === 0) continue

      const verifyEnabled = m.options?.verifyAfterCopy !== false
      const allTerminal = items.every((i) => {
        const s = String(i.slurperStatus ?? "").toLowerCase()
        if (!verifyEnabled) return isTerminal(i.slurperStatus)
        if (isSuccess(s)) {
          const v = readBucketVerifyState(i.progress)
          return v?.status === "ok" || v?.status === "error"
        }
        return isTerminal(i.slurperStatus)
      })
      if (!allTerminal) continue

      const anyAborted = items.some((i) => {
        const s = String(i.slurperStatus ?? "").toLowerCase()
        return s === "aborted" || s === "canceled" || s === "cancelled" || s === "copy_aborted"
      })
      const anySlurperFailure = items.some((i) => failedLike(String(i.slurperStatus ?? "").toLowerCase()))
      const anyVerifyFailure =
        verifyEnabled && items.some((i) => isSuccess(i.slurperStatus) && readBucketVerifyState(i.progress)?.status === "error")
      const allSuccess = items.every((i) => {
        const s = String(i.slurperStatus ?? "").toLowerCase()
        if (!isSuccess(s)) return false
        return !verifyEnabled || isVerifiedOk(i.progress)
      })

      if (anySlurperFailure) {
        await updateMigration(m.id, {
          status: "failed",
          syncStatus: "error",
          syncMessage: "One or more buckets failed",
          completedAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
        })
      } else if (anyAborted) {
        await updateMigration(m.id, {
          status: "canceled",
          syncStatus: "ok",
          syncMessage: "Migration aborted",
          completedAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
        })
      } else if (allSuccess) {
        await updateMigration(m.id, {
          status: "completed",
          syncStatus: "ok",
          syncMessage: "",
          completedAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
        })
      } else if (anyVerifyFailure) {
        await updateMigration(m.id, {
          status: "failed",
          syncStatus: "error",
          syncMessage: "Verification failed for one or more buckets",
          completedAt: new Date().toISOString(),
          lastSyncedAt: new Date().toISOString(),
        })
      }
    }

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
