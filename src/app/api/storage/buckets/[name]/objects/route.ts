import { NextResponse } from "next/server"
import { Readable } from "stream"
import { getAllAccounts } from "@/lib/accounts-store"
import { r2PutObject } from "@/lib/r2-s3"

type ActiveAccount = Awaited<ReturnType<typeof getAllAccounts>>[number] & {
  cloudflareAccountId: string
}

async function getActiveAccount() {
  const accounts = await getAllAccounts()
  const active = accounts.find((a) => a.status === "active")
  if (!active) {
    return { error: "No active Cloudflare account" as const }
  }
  if (!active.cloudflareAccountId) {
    return {
      error:
        "Active Cloudflare account is not synced. Sync the account first to list bucket objects." as const,
    }
  }
  return { active: active as ActiveAccount }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> }
) {
  try {
    const { name } = await context.params
    const { active, error } = await getActiveAccount()
    if (!active) {
      return NextResponse.json(
        { error, objects: [] },
        { status: 200 }
      )
    }

    const encoded = encodeURIComponent(name)
    const objectsRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${active.cloudflareAccountId}/r2/buckets/${encoded}/objects`,
      {
        headers: {
          Authorization: `Bearer ${active.apiToken}`,
        },
      }
    )

    if (!objectsRes.ok) {
      const body = await objectsRes.text().catch(() => "")
      console.error("R2 list objects failed:", body)
      return NextResponse.json(
        {
          error: "Unable to fetch bucket objects for active account",
          details: body,
          objects: [],
        },
        { status: 200 }
      )
    }

    const objectsBody = await objectsRes.json()
    const result = objectsBody?.result
    const objectsArray = Array.isArray(result?.objects)
      ? result.objects
      : Array.isArray(result)
      ? result
      : []

    const objects = objectsArray.map((obj: any) => ({
      id: String(obj?.key ?? obj?.name ?? ""),
      name: String(obj?.key ?? obj?.name ?? "object"),
      size:
        typeof obj?.size === "number"
          ? obj.size
          : typeof obj?.bytes === "number"
          ? obj.bytes
          : 0,
      contentType:
        typeof obj?.http_metadata?.contentType === "string"
          ? obj.http_metadata.contentType
          : undefined,
      uploaded:
        typeof obj?.uploaded === "string"
          ? obj.uploaded
          : typeof obj?.uploaded_at === "string"
          ? obj.uploaded_at
          : undefined,
    }))

    return NextResponse.json({ objects })
  } catch (error: any) {
    const message = error?.message ?? "Unable to list bucket objects"
    return NextResponse.json({ error: message, objects: [] }, { status: 200 })
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> }
) {
  try {
    const { name } = await context.params
    const { active, error } = await getActiveAccount()
    if (!active) {
      return NextResponse.json({ error }, { status: 400 })
    }

    if (!active.r2AccessKeyId || !active.r2SecretAccessKey) {
      return NextResponse.json(
        { error: "Active Cloudflare account is missing R2 access key pair" },
        { status: 400 }
      )
    }

    const contentType = request.headers.get("content-type") ?? ""

    if (contentType.startsWith("multipart/form-data")) {
      const formData = await request.formData()
      const file = formData.get("file") as File | null
      const path = String(formData.get("path") ?? "")

      if (!file) {
        return NextResponse.json(
          { error: "File is required" },
          { status: 400 }
        )
      }

      const key = `${path}${file.name}`
      // Stream the browser File directly into the Upload helper without buffering
      const nodeStream = Readable.from(file.stream() as any)

      try {
        await r2PutObject(
          {
            accountId: active.cloudflareAccountId,
            accessKeyId: active.r2AccessKeyId,
            secretAccessKey: active.r2SecretAccessKey,
          },
          name,
          key,
          nodeStream
        )
      } catch (err: any) {
        const message = String(err?.message ?? "R2 upload failed")
        console.error("R2 upload object failed:", message)
        return NextResponse.json(
          { error: "Unable to upload object", details: message },
          { status: 400 }
        )
      }

      return NextResponse.json({ ok: true, key })
    }

    const { action, key, content } = await request.json().catch(() => ({}))

    if (!key || typeof key !== "string") {
      return NextResponse.json(
        { error: "Object key is required" },
        { status: 400 }
      )
    }

    if (action !== "folder" && action !== "file") {
      return NextResponse.json(
        { error: "Unsupported action" },
        { status: 400 }
      )
    }

    const body =
      typeof content === "string"
        ? content
        : action === "folder"
        ? ""
        : ""

    try {
      await r2PutObject(
        {
          accountId: active.cloudflareAccountId,
          accessKeyId: active.r2AccessKeyId,
          secretAccessKey: active.r2SecretAccessKey,
        },
        name,
        key,
        body
      )
    } catch (err: any) {
      const message = String(err?.message ?? "R2 create object failed")
      console.error("R2 create object failed:", message)
      return NextResponse.json(
        { error: "Unable to create object", details: message },
        { status: 400 }
      )
    }

    return NextResponse.json({ ok: true, key })
  } catch (error: any) {
    const message = error?.message ?? "Unable to modify bucket objects"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
