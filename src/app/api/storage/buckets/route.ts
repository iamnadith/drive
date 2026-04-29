import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { r2ListBuckets } from "@/lib/cloudflare-r2-buckets"
import { r2CreateBucket } from "@/lib/r2-s3"
import { ensureBucketStatsRows, getBucketStatsMap } from "@/lib/bucket-stats-store"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const accounts = await getAllAccounts()
    const active = accounts.find((a) => a.status === "active")

    if (!active) {
      return NextResponse.json(
        { error: "No active Cloudflare account", buckets: [], totalBytes: 0 },
        { status: 404 }
      )
    }

    if (!active.cloudflareAccountId) {
      return NextResponse.json(
        {
          error:
            "Active Cloudflare account is not synced. Sync the account first to list buckets.",
          buckets: [],
          totalBytes: 0,
        },
        { status: 409 }
      )
    }

    const bucketsList = await r2ListBuckets({
      accountId: active.cloudflareAccountId,
      apiToken: active.apiToken,
    })

    const bucketNames = bucketsList.map((b) => b.name).filter(Boolean)
    let statsMap = new Map<string, { objects: number; bytes: number; status: string; error?: string }>()
    let statsError: string | null = null
    try {
      await ensureBucketStatsRows(active.id, bucketNames)
      const map = await getBucketStatsMap(active.id)
      statsMap = new Map(Array.from(map.entries()).map(([k, v]) => [k, v]))
    } catch (e: unknown) {
      statsError =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to load bucket stats")
          : "Unable to load bucket stats"
    }

    const results = bucketNames
      .map((name) => {
        const bucket = bucketsList.find((b) => b.name === name)
        const stats = statsMap.get(name)

        const fallbackObjects = typeof bucket?.objects === "number" ? bucket.objects : 0
        const fallbackBytes = typeof bucket?.size === "number" ? bucket.size : 0

        // Prefer cached stats even while running so the UI shows non-zero progressively.
        const objects =
          typeof stats?.objects === "number" && stats.objects > 0 ? stats.objects : fallbackObjects
        const bytes = typeof stats?.bytes === "number" && stats.bytes > 0 ? stats.bytes : fallbackBytes

        return {
          id: name,
          name,
          objects,
          bytes,
          statsStatus: stats?.status ?? "pending",
          statsError: stats?.error ?? statsError ?? undefined,
          createdAt: bucket?.creation_date,
          jurisdiction: bucket?.jurisdiction,
          storageClass: bucket?.storage_class,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))

    const totalBytes = results.reduce((sum: number, b: { bytes: number }) => sum + (b.bytes ?? 0), 0)
    return NextResponse.json({ buckets: results, totalBytes, ...(statsError ? { error: statsError } : {}) })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to list buckets")
    return NextResponse.json(
      { error: message, buckets: [], totalBytes: 0 },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { name } = (await request.json().catch(() => ({}))) as { name?: unknown }

    if (!name || typeof name !== "string") {
      return NextResponse.json(
        { error: "Bucket name is required" },
        { status: 400 }
      )
    }

    const trimmed = name.trim()
    if (!trimmed) {
      return NextResponse.json(
        { error: "Bucket name is required" },
        { status: 400 }
      )
    }

    // R2 bucket names must be DNS-compatible: lowercase, numbers, hyphens.
    const safeName = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")

    if (!safeName) {
      return NextResponse.json(
        { error: "Bucket name must contain letters or numbers" },
        { status: 400 }
      )
    }

    const accounts = await getAllAccounts()
    const active = accounts.find((a) => a.status === "active")

    if (
      !active ||
      !active.cloudflareAccountId ||
      !active.r2AccessKeyId ||
      !active.r2SecretAccessKey
    ) {
      return NextResponse.json(
        {
          error:
            "Active Cloudflare account is missing R2 credentials (account ID or key pair).",
        },
        { status: 400 }
      )
    }

    try {
      await r2CreateBucket(
        {
          accountId: active.cloudflareAccountId,
          accessKeyId: active.r2AccessKeyId,
          secretAccessKey: active.r2SecretAccessKey,
        },
        safeName
      )
    } catch (err: unknown) {
      const raw = errorMessage(err, "Unknown error")
      console.error("R2 create bucket failed:", raw)

      return NextResponse.json(
        {
          error: "Unable to create R2 bucket",
          details: raw,
        },
        { status: 400 }
      )
    }

    return NextResponse.json({ ok: true, name: safeName })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to create bucket")
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
