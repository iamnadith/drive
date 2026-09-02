import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
  projectIdFromUrl,
} from "@/lib/project-api-auth"
import {
  assertProjectObjectWritable,
  getProjectObjectInventoryByFileId,
  getProjectObjectInventoryByKey,
  recordProjectApiEvent,
  syncTrackedBucketObject,
} from "@/lib/project-operations-store"
import { projectObjectLockResponse } from "@/lib/project-object-lock"
import { r2HeadObject, r2UpdateObjectMetadata } from "@/lib/r2-s3"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectId = projectIdFromUrl(request)
  const requestedBucketName = projectBucketFromRequest(request)
  const key = url.searchParams.get("key")?.trim() ?? ""
  const fileId = url.searchParams.get("fileId")?.trim() ?? ""
  if (!key && !fileId) {
    return NextResponse.json({ error: "Object key or fileId is required" }, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "readMetadata")
  if ("response" in authorized) return authorized.response
  const object = fileId
    ? await getProjectObjectInventoryByFileId(authorized.auth.project.id, fileId)
    : null
  if (fileId && !object) return NextResponse.json({ error: "File not found" }, { status: 404 })
  const resolvedKey = object?.key ?? key
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, object?.bucketName ?? requestedBucketName)
  if ("response" in r2) return r2.response

  const head = await r2HeadObject(r2.config, r2.bucketName, resolvedKey)
  const trackedObject = object ?? (await getProjectObjectInventoryByKey(authorized.auth.project.id, r2.bucketName, resolvedKey))
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.metadata.read",
    objectKey: resolvedKey,
    request,
    metadata: trackedObject?.fileId ? { fileId: trackedObject.fileId } : undefined,
  })
  return NextResponse.json({
    projectId,
    key: resolvedKey,
    fileId: trackedObject?.fileId ?? fileId ?? null,
    size: head.ContentLength ?? 0,
    contentType: head.ContentType,
    etag: head.ETag,
    lastModified: head.LastModified?.toISOString(),
    metadata: head.Metadata ?? {},
  })
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    fileId?: unknown
    key?: unknown
    metadata?: unknown
    contentType?: unknown
    ifMatch?: unknown
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
  if (!key && !fileId) {
    return NextResponse.json({ error: "Object key or fileId is required" }, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "writeMetadata")
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
  } catch (error) {
    return projectObjectLockResponse(error, {
      operation: "file.metadata.write",
      projectId: authorized.auth.project.id,
      bucketName: r2.bucketName,
      key,
    })
  }

  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? Object.fromEntries(
          Object.entries(body.metadata as Record<string, unknown>).map(([k, v]) => [k, String(v)])
        )
      : {}
  await r2UpdateObjectMetadata(r2.config, r2.bucketName, key, {
    metadata,
    contentType: typeof body.contentType === "string" ? body.contentType : undefined,
    ifMatch:
      typeof body.ifMatch === "string"
        ? body.ifMatch
        : request.headers.get("if-match") ?? undefined,
  })
  const head = await r2HeadObject(r2.config, r2.bucketName, key).catch(() => null)
  const trackedObject = await syncTrackedBucketObject({
    config: r2.config,
    projectId: authorized.auth.project.id,
    bucketName: r2.bucketName,
    key,
  }).catch(() => undefined)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.metadata.write",
    objectKey: key,
    request,
    metadata: trackedObject?.fileId ? { fileId: trackedObject.fileId } : undefined,
  })
  return NextResponse.json({
    ok: true,
    projectId,
    key,
    fileId: trackedObject?.fileId ?? fileId ?? null,
    metadata: head?.Metadata ?? metadata,
  })
}
