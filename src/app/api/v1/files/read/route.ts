import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
  projectIdFromUrl,
} from "@/lib/project-api-auth"
import { recordProjectApiEvent } from "@/lib/project-operations-store"
import { r2CreateSignedDownloadUrl } from "@/lib/r2-s3"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectId = projectIdFromUrl(request)
  const bucketName = projectBucketFromRequest(request)
  const key = url.searchParams.get("key")?.trim() ?? ""
  if (!key) return NextResponse.json({ error: "Object key is required" }, { status: 400 })

  const authorized = await authorizeProjectRequest(request, projectId, "read")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return r2.response

  const signedUrl = await r2CreateSignedDownloadUrl(
    r2.config,
    r2.bucketName,
    key,
    { expiresInSeconds: 300 }
  )
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.read.redirect",
    objectKey: key,
    status: 302,
    request,
  })
  return NextResponse.redirect(signedUrl, 302)
}
