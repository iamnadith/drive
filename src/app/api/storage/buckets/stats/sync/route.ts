import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { r2ListBuckets } from "@/lib/cloudflare-r2-buckets"
import { r2ListObjectsPage } from "@/lib/r2-s3"
import {
  ensureBucketStatsRows,
  getBucketStatsMap,
  updateBucketStats,
  type BucketStatsStatus,
} from "@/lib/bucket-stats-store"
import { requireAdmin } from "@/lib/server-auth"

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
    const statsMap = await getBucketStatsMap(active.id)

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
        updated.push({ bucket: bucketName, status: "error", objects: row.objects ?? 0, bytes: row.bytes ?? 0, error: message })
        continue
      }
    }

    return NextResponse.json({ ok: true, updated, remainingBudget: remaining })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unable to sync bucket stats")
        : "Unable to sync bucket stats"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
