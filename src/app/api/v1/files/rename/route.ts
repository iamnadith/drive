import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectR2Config,
} from "@/lib/project-api-auth"
import {
  assertProjectObjectWritable,
  createProjectOperationJob,
  markProjectObjectDeleted,
  processProjectOperationJob,
  recordProjectApiEvent,
  upsertProjectObjectInventory,
} from "@/lib/project-operations-store"
import { r2CopyObject, r2DeleteObject, r2HeadObject } from "@/lib/r2-s3"

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
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
  const fromKey = typeof body.fromKey === "string" ? body.fromKey.trim() : ""
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

  if (prefixRename || body.async === true) {
    const job = await createProjectOperationJob({
      projectIdentifier: authorized.auth.project.id,
      type: prefixRename ? "prefix_rename" : "batch_move",
      payload: prefixRename
        ? { fromPrefix, toPrefix }
        : { items: [{ fromKey, toKey, ifMatch: body.ifMatch ?? request.headers.get("if-match") }] },
      idempotencyKey: request.headers.get("idempotency-key"),
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
      metadata: { jobId: job.id },
    })
    return NextResponse.json({ job }, { status: 202 })
  }

  const r2 = await getActiveProjectR2Config(authorized.auth.project)
  if ("response" in r2) return r2.response
  try {
    await assertProjectObjectWritable(
      authorized.auth.project.id,
      fromKey,
      request.headers.get("x-drive-lock-token")
    )
  } catch {
    return NextResponse.json({ error: "Object is locked" }, { status: 409 })
  }

  await r2CopyObject(r2.config, authorized.auth.project.bucketName, fromKey, toKey, {
    ifMatch:
      typeof body.ifMatch === "string"
        ? body.ifMatch
        : request.headers.get("if-match") ?? undefined,
  })
  await r2DeleteObject(r2.config, authorized.auth.project.bucketName, fromKey)
  const head = await r2HeadObject(r2.config, authorized.auth.project.bucketName, toKey).catch(() => null)
  await upsertProjectObjectInventory({
    projectId: authorized.auth.project.id,
    key: toKey,
    size: head?.ContentLength ?? 0,
    etag: head?.ETag,
    contentType: head?.ContentType,
    metadata: head?.Metadata,
    lastModified: head?.LastModified?.toISOString(),
  }).catch(() => undefined)
  await markProjectObjectDeleted(authorized.auth.project.id, fromKey).catch(() => undefined)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.rename",
    objectKey: fromKey,
    request,
    metadata: { toKey },
  })
  return NextResponse.json({ ok: true, projectId, fromKey, toKey })
}
