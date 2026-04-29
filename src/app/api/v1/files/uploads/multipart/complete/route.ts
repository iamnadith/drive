import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectR2Config,
} from "@/lib/project-api-auth"
import {
  recordProjectApiEvent,
  upsertProjectObjectInventory,
} from "@/lib/project-operations-store"
import { r2CompleteMultipartUpload, r2HeadObject } from "@/lib/r2-s3"

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
  const r2 = await getActiveProjectR2Config(authorized.auth.project)
  if ("response" in r2) return r2.response

  await r2CompleteMultipartUpload(
    r2.config,
    authorized.auth.project.bucketName,
    key,
    uploadId,
    parts
  )
  const head = await r2HeadObject(r2.config, authorized.auth.project.bucketName, key).catch(() => null)
  await upsertProjectObjectInventory({
    projectId: authorized.auth.project.id,
    key,
    size: head?.ContentLength ?? 0,
    etag: head?.ETag,
    contentType: head?.ContentType,
    metadata: head?.Metadata,
    lastModified: head?.LastModified?.toISOString(),
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
