import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectR2Config,
  projectIdFromUrl,
} from "@/lib/project-api-auth"
import {
  assertProjectObjectWritable,
  createProjectOperationJob,
  markProjectObjectDeleted,
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
  const authorized = await authorizeProjectRequest(request, projectId, "list")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectR2Config(authorized.auth.project)
  if ("response" in r2) return r2.response

  const page = await r2ListObjectsPageWithDelimiter(
    r2.config,
    authorized.auth.project.bucketName,
    {
      prefix: url.searchParams.get("prefix") ?? undefined,
      continuationToken: url.searchParams.get("cursor") ?? undefined,
      maxKeys: Math.max(1, Math.min(1000, toNumber(url.searchParams.get("limit"), 100))),
      delimiter: "/",
    }
  )
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.list",
    request,
    metadata: { prefix: url.searchParams.get("prefix") ?? "" },
  })

  return NextResponse.json({
    projectId: authorized.auth.project.projectId,
    prefix: url.searchParams.get("prefix") ?? "",
    folders: (page.CommonPrefixes ?? [])
      .map((item) => item.Prefix)
      .filter((item): item is string => Boolean(item)),
    objects: (page.Contents ?? [])
      .map((item) => ({
        key: item.Key ?? "",
        size: item.Size ?? 0,
        etag: item.ETag,
        lastModified: item.LastModified?.toISOString(),
      }))
      .filter((item) => item.key),
    nextCursor: page.NextContinuationToken ?? null,
    isTruncated: Boolean(page.IsTruncated),
  })
}

export async function DELETE(request: Request) {
  const url = new URL(request.url)
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    key?: unknown
    recursive?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    projectIdFromUrl(request)
  const key =
    (typeof body.key === "string" ? body.key.trim() : "") ||
    url.searchParams.get("key")?.trim() ||
    ""
  const recursive = body.recursive === true || url.searchParams.get("recursive") === "true"
  if (!key) return NextResponse.json({ error: "Object key is required" }, { status: 400 })

  const authorized = await authorizeProjectRequest(request, projectId, "delete")
  if ("response" in authorized) return authorized.response
  if (!recursive) {
    try {
      await assertProjectObjectWritable(
        authorized.auth.project.id,
        key,
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
      payload: { prefix },
      idempotencyKey: request.headers.get("idempotency-key"),
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
      metadata: { jobId: job.id },
    })
    return NextResponse.json({ job }, { status: 202 })
  }

  const r2 = await getActiveProjectR2Config(authorized.auth.project)
  if ("response" in r2) return r2.response
  await r2DeleteObject(r2.config, authorized.auth.project.bucketName, key)
  await markProjectObjectDeleted(authorized.auth.project.id, key).catch(() => undefined)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.delete",
    objectKey: key,
    request,
  })
  return NextResponse.json({ ok: true, projectId, deleted: 1 })
}
