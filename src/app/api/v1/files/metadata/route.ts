import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
  projectIdFromUrl,
} from "@/lib/project-api-auth"
import {
  assertProjectObjectWritable,
  recordProjectApiEvent,
  syncTrackedBucketObject,
} from "@/lib/project-operations-store"
import { r2HeadObject, r2UpdateObjectMetadata } from "@/lib/r2-s3"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectId = projectIdFromUrl(request)
  const bucketName = projectBucketFromRequest(request)
  const key = url.searchParams.get("key")?.trim() ?? ""
  if (!key) return NextResponse.json({ error: "Object key is required" }, { status: 400 })

  const authorized = await authorizeProjectRequest(request, projectId, "readMetadata")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return r2.response

  const head = await r2HeadObject(r2.config, r2.bucketName, key)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.metadata.read",
    objectKey: key,
    request,
  })
  return NextResponse.json({
    projectId,
    key,
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
  const key = typeof body.key === "string" ? body.key.trim() : ""
  if (!key) return NextResponse.json({ error: "Object key is required" }, { status: 400 })

  const authorized = await authorizeProjectRequest(request, projectId, "writeMetadata")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
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
  await syncTrackedBucketObject({
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
  })
  return NextResponse.json({ ok: true, projectId, key, metadata: head?.Metadata ?? metadata })
}
