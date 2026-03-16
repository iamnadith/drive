import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { getMigration, listMigrationItems } from "@/lib/migrations-store"
import { r2CreateSignedDownloadUrl, r2HeadObject } from "@/lib/r2-s3"

export const runtime = "nodejs"

function toSafeFilename(key: string): string {
  const base = key.split("/").pop() || key
  return base.replace(/[\\/:*?"<>|]/g, "_")
}

export async function GET(request: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await context.params
    const url = new URL(request.url)
    const side = (url.searchParams.get("side") || "source").toLowerCase()
    const key = url.searchParams.get("key") || ""
    if (!key.trim()) return NextResponse.json({ error: "Missing key" }, { status: 400 })
    if (side !== "source" && side !== "destination") {
      return NextResponse.json({ error: "Invalid side" }, { status: 400 })
    }

    const migration = await getMigration(id)
    if (!migration) return NextResponse.json({ error: "Migration not found" }, { status: 404 })

    const items = await listMigrationItems(id)
    const item = items.find((i) => i.id === itemId)
    if (!item) return NextResponse.json({ error: "Migration item not found" }, { status: 404 })

    const accounts = await getAllAccounts()
    const source = accounts.find((a) => a.id === migration.sourceAccountId)
    const target = accounts.find((a) => a.id === migration.targetAccountId)
    if (!source || !target) return NextResponse.json({ error: "Source/target account not found" }, { status: 400 })
    if (!source.cloudflareAccountId || !target.cloudflareAccountId) {
      return NextResponse.json({ error: "Cloudflare account ids are not synced" }, { status: 400 })
    }

    const chosen =
      side === "source"
        ? {
            accountId: source.cloudflareAccountId,
            accessKeyId: source.r2AccessKeyId,
            secretAccessKey: source.r2SecretAccessKey,
            bucket: item.sourceBucket,
          }
        : {
            accountId: target.cloudflareAccountId,
            accessKeyId: target.r2AccessKeyId,
            secretAccessKey: target.r2SecretAccessKey,
            bucket: item.targetBucket,
          }

    const head = await r2HeadObject(
      {
        accountId: chosen.accountId,
        accessKeyId: chosen.accessKeyId,
        secretAccessKey: chosen.secretAccessKey,
      },
      chosen.bucket,
      key
    )
    const signedUrl = await r2CreateSignedDownloadUrl(
      {
        accountId: chosen.accountId,
        accessKeyId: chosen.accessKeyId,
        secretAccessKey: chosen.secretAccessKey,
      },
      chosen.bucket,
      key,
      {
        expiresInSeconds: 300,
        filename: toSafeFilename(key),
        contentType: typeof head.ContentType === "string" ? head.ContentType : undefined,
      }
    )

    return NextResponse.redirect(signedUrl, { status: 307 })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unable to download object")
        : "Unable to download object"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
