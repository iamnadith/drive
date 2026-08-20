import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
  projectIdFromUrl,
} from "@/lib/project-api-auth"
import {
  getProjectObjectInventoryByFileId,
  recordProjectApiEvent,
} from "@/lib/project-operations-store"
import { r2CreateSignedDownloadUrl } from "@/lib/r2-s3"
import { rejectDisallowedBucketDeliveryOrigin } from "@/lib/bucket-delivery-origin-guard"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectId = projectIdFromUrl(request)
  const requestedBucketName = projectBucketFromRequest(request)
  const key = url.searchParams.get("key")?.trim() ?? ""
  const fileId = url.searchParams.get("fileId")?.trim() ?? ""
  if (!key && !fileId) {
    return NextResponse.json({ error: "Object key or fileId is required" }, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "read")
  if ("response" in authorized) return authorized.response
  const object = fileId
    ? await getProjectObjectInventoryByFileId(authorized.auth.project.id, fileId)
    : null
  if (fileId && !object) return NextResponse.json({ error: "File not found" }, { status: 404 })
  const resolvedKey = object?.key ?? key
  const resolvedBucketName = object?.bucketName ?? requestedBucketName
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, resolvedBucketName)
  if ("response" in r2) return r2.response
  const originRejection = await rejectDisallowedBucketDeliveryOrigin(request, r2.bucketName)
  if (originRejection) return originRejection

  const signedUrl = await r2CreateSignedDownloadUrl(
    r2.config,
    r2.bucketName,
    resolvedKey,
    { expiresInSeconds: 300 }
  )
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.read.redirect",
    objectKey: resolvedKey,
    status: 302,
    request,
    metadata: fileId ? { fileId } : undefined,
  })
  return NextResponse.redirect(signedUrl, 302)
}
