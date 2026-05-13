import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
} from "@/lib/project-api-auth"
import {
  assertProjectObjectWritable,
  getProjectObjectInventoryByFileId,
  recordProjectApiEvent,
  syncTrackedBucketObject,
} from "@/lib/project-operations-store"
import { r2PutObject } from "@/lib/r2-s3"

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    fileId?: unknown
    key?: unknown
    content?: unknown
    contentType?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const bucketName =
    (typeof (body as { bucket?: unknown }).bucket === "string"
      ? String((body as { bucket?: unknown }).bucket).trim()
      : "") || projectBucketFromRequest(request)
  const fileId = typeof body.fileId === "string" ? body.fileId.trim() : ""
  let key = typeof body.key === "string" ? body.key.trim() : ""
  if (!key || key.endsWith("/")) {
    if (!fileId) return NextResponse.json({ error: "Valid object key or fileId is required" }, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "write")
  if ("response" in authorized) return authorized.response
  const object = fileId
    ? await getProjectObjectInventoryByFileId(authorized.auth.project.id, fileId)
    : null
  if (fileId && !object) return NextResponse.json({ error: "File not found" }, { status: 404 })
  key = object?.key ?? key
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, object?.bucketName ?? bucketName)
  if ("response" in r2) return r2.response
  try {
    await assertProjectObjectWritable(
      authorized.auth.project.id,
      r2.bucketName,
      key,
      request.headers.get("x-drive-lock-token")
    )
  } catch {
    return NextResponse.json({ error: "Object is locked" }, { status: 409 })
  }

  const content =
    typeof body.content === "string"
      ? body.content
      : body.content === undefined || body.content === null
        ? ""
        : JSON.stringify(body.content)

  await r2PutObject(r2.config, r2.bucketName, key, content, {
    contentType:
      typeof body.contentType === "string" && body.contentType.trim()
        ? body.contentType.trim()
        : "text/plain; charset=utf-8",
    ifMatch: request.headers.get("if-match") ?? undefined,
    ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
  })
  const trackedObject = await syncTrackedBucketObject({
    config: r2.config,
    projectId: authorized.auth.project.id,
    bucketName: r2.bucketName,
    key,
  }).catch(() => undefined)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.write",
    objectKey: key,
    request,
    metadata: trackedObject?.fileId ? { fileId: trackedObject.fileId } : undefined,
  })

  return NextResponse.json({ ok: true, projectId, key, fileId: trackedObject?.fileId ?? fileId ?? null })
}
