import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
  resolveProjectBucketName,
} from "@/lib/project-api-auth"
import {
  assertProjectObjectWritable,
  createProjectOperationJob,
  getProjectObjectInventoryByFileId,
  processProjectOperationJob,
  recordProjectApiEvent,
  syncRenamedTrackedBucketObject,
} from "@/lib/project-operations-store"
import { projectObjectLockResponse } from "@/lib/project-object-lock"
import { r2CopyObject, r2DeleteObject } from "@/lib/r2-s3"

export const runtime = "nodejs"
export const maxDuration = 300

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    fileId?: unknown
    fromKey?: unknown
    toKey?: unknown
    fromPrefix?: unknown
    toPrefix?: unknown
    async?: unknown
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
  let fromKey = typeof body.fromKey === "string" ? body.fromKey.trim() : ""
  const toKey = typeof body.toKey === "string" ? body.toKey.trim() : ""
  const fromPrefix = typeof body.fromPrefix === "string" ? body.fromPrefix.trim() : ""
  const toPrefix = typeof body.toPrefix === "string" ? body.toPrefix.trim() : ""
  const prefixRename = Boolean(fromPrefix && toPrefix)
  if (!prefixRename && (!fromKey || !toKey || fromKey.endsWith("/") || toKey.endsWith("/"))) {
    return NextResponse.json(
      { error: "fromKey and toKey must be valid object keys" },
      { status: 400 }
    )
  }

  const authorized = await authorizeProjectRequest(request, projectId, "rename")
  if ("response" in authorized) return authorized.response
  const fileObject = fileId
    ? await getProjectObjectInventoryByFileId(authorized.auth.project.id, fileId)
    : null
  if (fileId && !fileObject) return NextResponse.json({ error: "File not found" }, { status: 404 })
  fromKey = fileObject?.key ?? fromKey
  const resolvedBucket = await resolveProjectBucketName(authorized.auth.project, bucketName)
  if ("response" in resolvedBucket) return resolvedBucket.response
  const effectiveBucketName = fileObject?.bucketName ?? resolvedBucket.bucketName
  const idempotencyKey = request.headers.get("idempotency-key")?.trim()

  if (prefixRename || body.async === true) {
    const job = await createProjectOperationJob({
      projectIdentifier: authorized.auth.project.id,
      type: prefixRename ? "prefix_rename" : "batch_move",
      payload: prefixRename
        ? { fromPrefix, toPrefix, bucketName: effectiveBucketName }
        : {
            items: [{ fromKey, toKey, ifMatch: body.ifMatch ?? request.headers.get("if-match") }],
            bucketName: effectiveBucketName,
          },
      idempotencyKey: idempotencyKey ? `${effectiveBucketName}:${idempotencyKey}` : undefined,
    })
    void processProjectOperationJob(job.id).catch((error) => {
      console.error("Rename job failed:", error)
    })
    await recordProjectApiEvent({
      project: authorized.auth.project,
      apiKeyId: authorized.auth.apiKey.id,
      action: prefixRename ? "file.prefix_rename.queued" : "file.rename.queued",
      objectKey: prefixRename ? fromPrefix : fromKey,
      status: 202,
      request,
      metadata: { jobId: job.id, bucketName: effectiveBucketName, ...(fileId ? { fileId } : {}) },
    })
    return NextResponse.json({ job }, { status: 202 })
  }

  const r2 = await getActiveProjectBucketR2Config(
    authorized.auth.project,
    fileObject?.bucketName ?? bucketName
  )
  if ("response" in r2) return r2.response
  try {
    await assertProjectObjectWritable(
      authorized.auth.project.id,
      r2.bucketName,
      fromKey,
      request.headers.get("x-drive-lock-token")
    )
  } catch (error) {
    return projectObjectLockResponse(error, {
      operation: "file.rename",
      projectId: authorized.auth.project.id,
      bucketName: r2.bucketName,
      key: fromKey,
    })
  }

  await r2CopyObject(r2.config, r2.bucketName, fromKey, toKey, {
    ifMatch:
      typeof body.ifMatch === "string"
        ? body.ifMatch
        : request.headers.get("if-match") ?? undefined,
  })
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
    action: "file.rename",
    objectKey: fromKey,
    request,
    metadata: { toKey, ...(trackedObject?.fileId ? { fileId: trackedObject.fileId } : {}) },
  })
  return NextResponse.json({ ok: true, projectId, fromKey, toKey, fileId: trackedObject?.fileId ?? fileId ?? null })
}
