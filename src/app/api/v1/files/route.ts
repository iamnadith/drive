import { after, NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
  projectIdFromUrl,
} from "@/lib/project-api-auth"
import {
  assertProjectObjectWritable,
  createProjectOperationJob,
  getProjectObjectInventoriesByKeys,
  getProjectObjectInventoryByFileId,
  markTrackedBucketObjectDeleted,
  processProjectOperationJob,
  recordProjectApiEvent,
} from "@/lib/project-operations-store"
import { r2DeleteObject, r2ListObjectsPageWithDelimiter } from "@/lib/r2-s3"

function toNumber(value: string | null, fallback: number) {
  const parsed = value ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectId = projectIdFromUrl(request)
  const bucketName = projectBucketFromRequest(request)
  const authorized = await authorizeProjectRequest(request, projectId, "list")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return r2.response

  const page = await r2ListObjectsPageWithDelimiter(
    r2.config,
    r2.bucketName,
    {
      prefix: url.searchParams.get("prefix") ?? undefined,
      continuationToken: url.searchParams.get("cursor") ?? undefined,
      maxKeys: Math.max(1, Math.min(1000, toNumber(url.searchParams.get("limit"), 100))),
      delimiter: "/",
    }
  )
  after(() => recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.list",
    request,
    metadata: { prefix: url.searchParams.get("prefix") ?? "" },
  }))

  const objects = (page.Contents ?? [])
    .map((item) => ({
      key: item.Key ?? "",
      size: item.Size ?? 0,
      etag: item.ETag,
      lastModified: item.LastModified?.toISOString(),
    }))
    .filter((item) => item.key)
  const inventory = await getProjectObjectInventoriesByKeys({
    projectId: authorized.auth.project.id,
    bucketName: r2.bucketName,
    keys: objects.map((item) => item.key),
  })

  return NextResponse.json({
    projectId: authorized.auth.project.projectId,
    prefix: url.searchParams.get("prefix") ?? "",
    folders: (page.CommonPrefixes ?? [])
      .map((item) => item.Prefix)
      .filter((item): item is string => Boolean(item)),
    objects: objects.map((item) => ({
      ...item,
      fileId: inventory.get(item.key)?.fileId,
    })),
    nextCursor: page.NextContinuationToken ?? null,
    isTruncated: Boolean(page.IsTruncated),
  })
}

export async function DELETE(request: Request) {
  const url = new URL(request.url)
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    fileId?: unknown
    key?: unknown
    recursive?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    projectIdFromUrl(request)
  const fileId = typeof body.fileId === "string" ? body.fileId.trim() : ""
  const key =
    (typeof body.key === "string" ? body.key.trim() : "") ||
    url.searchParams.get("key")?.trim() ||
    ""
  const recursive = body.recursive === true || url.searchParams.get("recursive") === "true"
  const bucketName =
    (typeof (body as { bucket?: unknown }).bucket === "string" ? String((body as { bucket?: unknown }).bucket).trim() : "") ||
    projectBucketFromRequest(request)
  if (!key && !fileId) {
    return NextResponse.json({ error: "Object key or fileId is required" }, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "delete")
  if ("response" in authorized) return authorized.response
  const object = fileId
    ? await getProjectObjectInventoryByFileId(authorized.auth.project.id, fileId)
    : null
  if (fileId && !object) return NextResponse.json({ error: "File not found" }, { status: 404 })
  if (recursive && fileId) {
    return NextResponse.json({ error: "Recursive delete requires an object key or prefix" }, { status: 400 })
  }
  const resolvedKey = object?.key ?? key
  const resolvedBucketName = object?.bucketName ?? bucketName
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, resolvedBucketName)
  if ("response" in r2) return r2.response
  const idempotencyKey = request.headers.get("idempotency-key")?.trim()
  if (!recursive) {
    try {
      await assertProjectObjectWritable(
        authorized.auth.project.id,
        r2.bucketName,
        resolvedKey,
        request.headers.get("x-drive-lock-token")
      )
    } catch {
      return NextResponse.json({ error: "Object is locked" }, { status: 409 })
    }
  }

  if (recursive) {
    const prefix = key.endsWith("/") ? key : `${key}/`
    const job = await createProjectOperationJob({
      projectIdentifier: authorized.auth.project.id,
      type: "recursive_delete",
      payload: { prefix, bucketName: r2.bucketName },
      idempotencyKey: idempotencyKey ? `${r2.bucketName}:${idempotencyKey}` : undefined,
    })
    void processProjectOperationJob(job.id).catch((error) => {
      console.error("Recursive delete job failed:", error)
    })
    await recordProjectApiEvent({
      project: authorized.auth.project,
      apiKeyId: authorized.auth.apiKey.id,
      action: "file.delete.recursive.queued",
      objectKey: prefix,
      status: 202,
      request,
      metadata: { jobId: job.id, bucketName: r2.bucketName },
    })
    return NextResponse.json({ job }, { status: 202 })
  }

  await r2DeleteObject(r2.config, r2.bucketName, resolvedKey)
  await markTrackedBucketObjectDeleted({
    projectId: authorized.auth.project.id,
    bucketName: r2.bucketName,
    key: resolvedKey,
  }).catch(() => undefined)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.delete",
    objectKey: resolvedKey,
    request,
    metadata: object?.fileId ? { fileId: object.fileId } : undefined,
  })
  return NextResponse.json({ ok: true, projectId, deleted: 1, key: resolvedKey, fileId: object?.fileId ?? null })
}
