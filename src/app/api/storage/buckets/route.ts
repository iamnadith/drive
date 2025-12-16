import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { r2CreateBucket } from "@/lib/r2-s3"

export async function GET() {
  try {
    const accounts = await getAllAccounts()
    const active = accounts.find((a) => a.status === "active")

    if (!active) {
      return NextResponse.json(
        { error: "No active Cloudflare account", buckets: [], totalBytes: 0 },
        { status: 200 }
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
        { status: 200 }
      )
    }

    const bucketsRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${active.cloudflareAccountId}/r2/buckets`,
      {
        headers: {
          Authorization: `Bearer ${active.apiToken}`,
        },
      }
    )

    if (!bucketsRes.ok) {
      const body = await bucketsRes.text().catch(() => "")
      return NextResponse.json(
        {
          error: "Unable to fetch R2 buckets for active account",
          details: body,
          buckets: [],
          totalBytes: 0,
        },
        { status: 200 }
      )
    }

    const bucketsBody = await bucketsRes.json()
    const bucketsResult = bucketsBody?.result
    const bucketsArray = Array.isArray(bucketsResult?.buckets)
      ? bucketsResult.buckets
      : Array.isArray(bucketsResult)
      ? bucketsResult
      : []

    const buckets = bucketsArray.map((bucket: any) => {
      const objects =
        typeof bucket?.objects === "number"
          ? bucket.objects
          : typeof bucket?.object_count === "number"
          ? bucket.object_count
          : 0
      const bytes =
        typeof bucket?.size === "number"
          ? bucket.size
          : typeof bucket?.size_bytes === "number"
          ? bucket.size_bytes
          : 0

      return {
        id: String(bucket?.name ?? bucket?.id ?? ""),
        name: String(bucket?.name ?? "Unnamed bucket"),
        objects,
        bytes,
        createdAt:
          typeof bucket?.creation_date === "string"
            ? bucket.creation_date
            : undefined,
      }
    })

    const totalBytes = buckets.reduce(
      (sum: number, b: { bytes: number }) => sum + b.bytes,
      0
    )

    return NextResponse.json({ buckets, totalBytes })
  } catch (error: any) {
    const message = error?.message ?? "Unable to list buckets"
    return NextResponse.json(
      { error: message, buckets: [], totalBytes: 0 },
      { status: 200 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const { name } = await request.json().catch(() => ({} as any))

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
    } catch (err: any) {
      const raw = String(err?.message ?? "Unknown error")
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
  } catch (error: any) {
    const message = error?.message ?? "Unable to create bucket"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
