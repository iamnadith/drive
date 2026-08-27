import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { r2CreateBucket } from "@/lib/r2-s3"
import { requireAdmin } from "@/lib/server-auth"
import { listBucketStats } from "@/lib/bucket-stats-store"

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

    // Storage statistics are a Worker-owned projection. The panel only reads
    // the latest database snapshot and never enumerates R2 objects here.
    const stats = await listBucketStats(active.id)
    const results = stats
      .map((row) => ({
        id: row.bucketName,
        name: row.bucketName,
        objects: row.objects,
        bytes: row.bytes,
        statsStatus: row.status,
        statsError: row.error,
        updatedAt: row.updatedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    const bucketBytes = results.reduce((sum: number, b: { bytes: number }) => sum + (b.bytes ?? 0), 0)
    const totalBytes = active.syncStatus === "ok" ? active.totalBytes : bucketBytes
    return NextResponse.json({
      buckets: results,
      totalBytes,
      totalObjects: active.syncStatus === "ok"
        ? active.totalObjects
        : results.reduce((sum, bucket) => sum + bucket.objects, 0),
      totalBuckets: active.syncStatus === "ok" ? active.totalBuckets : results.length,
      source: "database",
    })
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
