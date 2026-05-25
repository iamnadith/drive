import { NextResponse } from "next/server"
import { authorizeProjectRequest, getActiveProjectBucketR2Config, projectBucketFromRequest } from "@/lib/project-api-auth"
import { buildProjectStorageObjectUrl } from "@/lib/project-storage-gateway"
import { assertProjectObjectWritable, getProjectObjectInventoryByFileId, recordProjectApiEvent, syncRenamedTrackedBucketObject } from "@/lib/project-operations-store"
import { r2CopyObject, r2DeleteObject } from "@/lib/r2-s3"

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    bucket?: unknown
    fromKey?: unknown
    fileId?: unknown
    toKey?: unknown
  }
  const projectId = (typeof body.projectId === "string" ? body.projectId.trim() : "") || request.headers.get("x-drive-project")?.trim() || ""
  const bucketName = (typeof body.bucket === "string" ? body.bucket.trim() : "") || projectBucketFromRequest(request)
  const fileId = typeof body.fileId === "string" ? body.fileId.trim() : ""
  const directFromKey = typeof body.fromKey === "string" ? body.fromKey.trim() : ""
  const toKey = typeof body.toKey === "string" ? body.toKey.trim() : ""
  if (!toKey) return NextResponse.json({ error: "Destination key is required" }, { status: 400 })

  const authorized = await authorizeProjectRequest(request, projectId, "rename")
  if ("response" in authorized) return authorized.response
  const object = fileId ? await getProjectObjectInventoryByFileId(authorized.auth.project.id, fileId) : null
  if (fileId && !object) return NextResponse.json({ error: "File not found" }, { status: 404 })
  const fromKey = object?.key ?? directFromKey
  if (!fromKey) return NextResponse.json({ error: "Source key or fileId is required" }, { status: 400 })
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, object?.bucketName ?? bucketName)
  if ("response" in r2) return r2.response

  try {
    await assertProjectObjectWritable(
      authorized.auth.project.id,
      r2.bucketName,
      fromKey,
      request.headers.get("x-drive-lock-token")
    )
  } catch {
    return NextResponse.json({ error: "Object is locked" }, { status: 409 })
  }

  await r2CopyObject(r2.config, r2.bucketName, fromKey, toKey)
  await r2DeleteObject(r2.config, r2.bucketName, fromKey)
  const trackedObject = await syncRenamedTrackedBucketObject({
    config: r2.config,
    projectId: authorized.auth.project.id,
    bucketName: r2.bucketName,
    fromKey,
    toKey,
  }).catch(() => undefined)

  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "storage.object.move",
    objectKey: fromKey,
    request,
    metadata: { toKey, ...(trackedObject?.fileId ? { fileId: trackedObject.fileId } : {}) },
  }).catch(() => undefined)

  return NextResponse.json({
    ok: true,
    fromKey,
    toKey,
    bucketName: r2.bucketName,
    fileId: trackedObject?.fileId ?? fileId ?? null,
    url: buildProjectStorageObjectUrl(request, r2.bucketName, toKey),
  })
}
