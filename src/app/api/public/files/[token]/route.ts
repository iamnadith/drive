import { NextResponse } from "next/server"
import { getActiveProjectBucketR2Config } from "@/lib/project-api-auth"
import { getProjectFileLinkByToken } from "@/lib/projects-store"
import { r2CreateSignedDownloadUrl } from "@/lib/r2-s3"

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params
  const resolved = await getProjectFileLinkByToken(token)
  if (!resolved) return NextResponse.json({ error: "Link not found" }, { status: 404 })

  const r2 = await getActiveProjectBucketR2Config(
    resolved.project,
    resolved.link.bucketName ?? resolved.project.bucketName
  )
  if ("response" in r2) return r2.response

  const url = new URL(request.url)
  const signedUrl = await r2CreateSignedDownloadUrl(
    r2.config,
    r2.bucketName,
    resolved.link.objectKey,
    {
      expiresInSeconds: 300,
      ...(url.searchParams.get("download") === "1"
        ? { filename: resolved.link.objectKey.split("/").pop() ?? resolved.link.objectKey }
        : {}),
    }
  )
  return NextResponse.redirect(signedUrl, 302)
}
