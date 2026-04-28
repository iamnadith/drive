import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { r2CreateSignedDownloadUrl } from "@/lib/r2-s3"

export async function GET(
  request: Request,
  context: { params: Promise<{ bucket: string; key: string[] }> }
) {
  const { bucket, key } = await context.params
  const objectKey = key.join("/")

  if (!bucket || !objectKey) {
    return NextResponse.json({ error: "Missing storage object path" }, { status: 400 })
  }

  const accounts = await getAllAccounts()
  const active = accounts.find((account) => account.status === "active")
  if (
    !active?.cloudflareAccountId ||
    !active.r2AccessKeyId ||
    !active.r2SecretAccessKey
  ) {
    return NextResponse.json(
      { error: "Active Cloudflare account is missing R2 credentials" },
      { status: 400 }
    )
  }

  const url = new URL(request.url)
  const download = url.searchParams.get("download") === "1"
  const signedUrl = await r2CreateSignedDownloadUrl(
    {
      accountId: active.cloudflareAccountId,
      accessKeyId: active.r2AccessKeyId,
      secretAccessKey: active.r2SecretAccessKey,
    },
    bucket,
    objectKey,
    {
      expiresInSeconds: 900,
      ...(download ? { filename: objectKey.split("/").pop() ?? objectKey } : {}),
    }
  )

  return NextResponse.redirect(signedUrl, 302)
}
