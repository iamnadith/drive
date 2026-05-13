import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
} from "@/lib/project-api-auth"
import {
  recordProjectApiEvent,
  syncTrackedBucketObject,
} from "@/lib/project-operations-store"
import { r2CompleteMultipartUpload } from "@/lib/r2-s3"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    key?: unknown
    uploadId?: unknown
    parts?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const bucketName =
    (typeof (body as { bucket?: unknown }).bucket === "string"
      ? String((body as { bucket?: unknown }).bucket).trim()
      : "") || projectBucketFromRequest(request)
  const key = typeof body.key === "string" ? body.key.trim() : ""
  const uploadId = typeof body.uploadId === "string" ? body.uploadId.trim() : ""
  const parts = Array.isArray(body.parts)
    ? body.parts
        .map((part) => {
          const item = part as { partNumber?: unknown; etag?: unknown }
          return { partNumber: Number(item.partNumber), etag: String(item.etag ?? "") }
        })
        .filter((part) => Number.isInteger(part.partNumber) && part.partNumber > 0 && part.etag)
    : []
  if (!key || !uploadId || parts.length === 0) {
    return NextResponse.json({ error: "key, uploadId and parts are required" }, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "upload")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return r2.response

  await r2CompleteMultipartUpload(
    r2.config,
    r2.bucketName,
    key,
    uploadId,
    parts
  )
  await syncTrackedBucketObject({
    config: r2.config,
    projectId: authorized.auth.project.id,
    bucketName: r2.bucketName,
    key,
  }).catch(() => undefined)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.multipart.complete",
    objectKey: key,
    request,
  })
  return NextResponse.json({ ok: true, projectId, key })
}
