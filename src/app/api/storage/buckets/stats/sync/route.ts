import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { r2ListBuckets } from "@/lib/cloudflare-r2-buckets"
import { r2ListObjectsPage } from "@/lib/r2-s3"
import {
  ensureBucketStatsRows,
  getBucketStatsMap,
  removeMissingBucketStats,
  resetBucketStats,
  updateBucketStats,
  type BucketStatsStatus,
} from "@/lib/bucket-stats-store"
import {
  completeObjectSync,
  failObjectSync,
  getRunningObjectSync,
  stageObjectPage,
  startObjectSync,
} from "@/lib/object-history-store"
import { requireAdmin } from "@/lib/server-auth"
import { scheduleDatabaseMaintenance } from "@/lib/database-maintenance"

export const runtime = "nodejs"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const body: unknown = await request.json().catch(() => ({}))
    const data = isRecord(body) ? body : {}
    const bucketFilter = typeof data.bucket === "string" ? data.bucket : ""
    const restart = data.restart === true
    const restartAfterMs =
      typeof data.restartAfterMs === "number" && Number.isFinite(data.restartAfterMs)
        ? Math.max(60_000, Math.floor(data.restartAfterMs))
        : null
    const maxKeysTotal =
      typeof data.maxKeysTotal === "number" && Number.isFinite(data.maxKeysTotal)
        ? Math.max(100, Math.min(50_000, Math.floor(data.maxKeysTotal)))
        : 5_000

    const accounts = await getAllAccounts()
    const active = accounts.find((a) => a.status === "active")
    if (!active?.cloudflareAccountId) {
      return NextResponse.json({ error: "No active Cloudflare account" }, { status: 404 })
    }
    if (!active.r2AccessKeyId || !active.r2SecretAccessKey) {
      return NextResponse.json({ error: "Active account missing R2 access key pair" }, { status: 409 })
    }

    const buckets = await r2ListBuckets({ accountId: active.cloudflareAccountId, apiToken: active.apiToken })
    const bucketNames = buckets.map((b) => b.name).filter(Boolean)

    if (bucketFilter) {
      if (!bucketNames.includes(bucketFilter)) {
        return NextResponse.json({ error: "Bucket not found in active account" }, { status: 404 })
      }
    }

    await ensureBucketStatsRows(active.id, bucketNames)
    await removeMissingBucketStats(active.id, bucketNames)
    let statsMap = await getBucketStatsMap(active.id)

    let objectSync = bucketFilter ? null : await getRunningObjectSync(active.id)
    const hasIncompleteStats = bucketNames.some((name) => statsMap.get(name)?.status !== "completed")
    const newestStatsUpdate = Math.max(
      0,
      ...bucketNames.map((name) => Date.parse(statsMap.get(name)?.updatedAt ?? "")).filter(Number.isFinite)
    )
    const statsAreStale = restartAfterMs !== null && Date.now() - newestStatsUpdate >= restartAfterMs
    if (!bucketFilter && !objectSync && (restart || hasIncompleteStats || statsAreStale)) {
      await resetBucketStats(active.id, bucketFilter ? [bucketFilter] : bucketNames)
      statsMap = await getBucketStatsMap(active.id)
      objectSync = await startObjectSync(active.id)
    }

    const scanOrder = bucketFilter
      ? [bucketFilter]
      : bucketNames.slice().sort((a, b) => a.localeCompare(b))

    const cfg = {
      accountId: active.cloudflareAccountId,
      accessKeyId: active.r2AccessKeyId,
      secretAccessKey: active.r2SecretAccessKey,
    }

    let remaining = maxKeysTotal
    const updated: Array<{
      bucket: string
      status: BucketStatsStatus
      objects: number
      bytes: number
      error?: string
    }> = []

    for (const bucketName of scanOrder) {
      if (remaining <= 0) break

      const row = statsMap.get(bucketName)
      if (!row) continue
      if (row.status === "completed") continue
      if (row.status === "error") continue

      try {
        // Mark as running (best-effort).
        if (row.status === "pending") {
          await updateBucketStats(active.id, bucketName, { status: "running", error: undefined })
        }

        let token = row.continuationToken
        let objects = row.objects ?? 0
        let bytes = row.bytes ?? 0

        while (remaining > 0) {
          const maxKeys = Math.min(1000, remaining)
          const page = await r2ListObjectsPage(cfg, bucketName, { continuationToken: token, maxKeys })

          const contents = Array.isArray(page.Contents) ? page.Contents : []
          if (objectSync) await stageObjectPage(objectSync.id, bucketName, contents)
          for (const obj of contents) {
            const key = typeof obj?.Key === "string" ? obj.Key : ""
            if (!key) continue
            objects += 1
            if (typeof obj?.Size === "number" && Number.isFinite(obj.Size)) bytes += obj.Size
          }

          const next =
            typeof page.NextContinuationToken === "string" ? page.NextContinuationToken : undefined

          // Budget is "how many keys we're willing to scan" per request. Normally that matches the
          // returned page size, but guard against providers returning empty pages with continuation.
          const scanned = contents.length > 0 ? contents.length : next ? maxKeys : 0
          remaining -= scanned

          token = next

          await updateBucketStats(active.id, bucketName, {
            objects,
            bytes,
            continuationToken: token,
            status: token ? "running" : "completed",
            error: undefined,
          })

          if (!token) break
          if (remaining <= 0) break
        }

        updated.push({ bucket: bucketName, status: token ? "running" : "completed", objects, bytes })
      } catch (error: unknown) {
        const message =
          typeof error === "object" && error !== null && "message" in error
            ? String((error as { message?: unknown }).message ?? "Unable to list objects")
            : "Unable to list objects"
        await updateBucketStats(active.id, bucketName, { status: "error", error: message })
        if (objectSync) await failObjectSync(objectSync.id, message).catch(() => undefined)
        updated.push({ bucket: bucketName, status: "error", objects: row.objects ?? 0, bytes: row.bytes ?? 0, error: message })
        continue
      }
    }

    const finalStats = await getBucketStatsMap(active.id)
    const complete = scanOrder.every((name) => finalStats.get(name)?.status === "completed")
    if (objectSync && complete) {
      await completeObjectSync(objectSync.id, active.id)
      scheduleDatabaseMaintenance()
    }

    return NextResponse.json({ ok: true, updated, remainingBudget: remaining, complete, runId: objectSync?.id ?? null })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unable to sync bucket stats")
        : "Unable to sync bucket stats"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
