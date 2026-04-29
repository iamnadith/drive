import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectR2Config,
  projectIdFromUrl,
} from "@/lib/project-api-auth"
import { recordProjectApiEvent } from "@/lib/project-operations-store"
import { r2CreateSignedDownloadUrl } from "@/lib/r2-s3"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectId = projectIdFromUrl(request)
  const key = url.searchParams.get("key")?.trim() ?? ""
  if (!key) return NextResponse.json({ error: "Object key is required" }, { status: 400 })

  const authorized = await authorizeProjectRequest(request, projectId, "download")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectR2Config(authorized.auth.project)
  if ("response" in r2) return r2.response

  const expiresInSeconds = Math.max(
    30,
    Math.min(3600, Number(url.searchParams.get("expiresInSeconds") ?? 900))
  )
  const signedUrl = await r2CreateSignedDownloadUrl(
    r2.config,
    authorized.auth.project.bucketName,
    key,
    {
      expiresInSeconds,
      filename: url.searchParams.get("download") === "1" ? key.split("/").pop() ?? key : undefined,
    }
  )
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.download.presign",
    objectKey: key,
    request,
  })

  if (url.searchParams.get("redirect") === "1") {
    return NextResponse.redirect(signedUrl, 302)
  }

  return NextResponse.json({
    url: signedUrl,
    key,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  })
}
