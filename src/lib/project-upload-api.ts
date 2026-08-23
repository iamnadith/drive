import { after, NextResponse } from "next/server"

import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
} from "@/lib/project-api-auth"
import {
  assertProjectObjectWritable,
  recordProjectApiEvent,
} from "@/lib/project-operations-store"
import {
  r2CreateMultipartUpload,
  r2CreateSignedUploadUrl,
  r2HeadObject,
} from "@/lib/r2-s3"

type UploadStartBody = {
  projectId?: unknown
  bucket?: unknown
  key?: unknown
  contentType?: unknown
  expiresInSeconds?: unknown
  ifMatch?: unknown
  ifNoneMatch?: unknown
  metadata?: unknown
  multipart?: unknown
}

type UploadCompleteBody = {
  projectId?: unknown
  bucket?: unknown
  key?: unknown
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// R2 is read-after-write consistent, but a direct upload can still reach the
// finalize endpoint before the edge observes the object. Keep a short retry
// window for that race; never hold a Vercel request for the old 50+ second
// worst case. The existing 202/pending response remains the retry contract.
const HEAD_UPLOAD_RETRY_ATTEMPTS = 4
const HEAD_UPLOAD_RETRY_DEADLINE_MS = 8_000
const HEAD_UPLOAD_TIMEOUT_MS = 2_000
const HEAD_UPLOAD_RETRY_MAX_DELAY_MS = 1_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Request timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    promise
      .then((value) => {
        clearTimeout(timeout)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timeout)
        reject(error)
      })
  })
}

async function headUploadedObjectWithRetry(
  config: Parameters<typeof r2HeadObject>[0],
  bucketName: string,
  key: string,
) {
  const deadline = Date.now() + HEAD_UPLOAD_RETRY_DEADLINE_MS
  for (let attempt = 0; attempt < HEAD_UPLOAD_RETRY_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const head = await withTimeout(
      r2HeadObject(config, bucketName, key),
      Math.min(HEAD_UPLOAD_TIMEOUT_MS, remaining)
    ).catch(() => null)
    if (head) return head
    const delayRemaining = deadline - Date.now()
    if (attempt < HEAD_UPLOAD_RETRY_ATTEMPTS - 1 && delayRemaining > 0) {
      await sleep(
        Math.min(
          HEAD_UPLOAD_RETRY_MAX_DELAY_MS,
          250 * (attempt + 1),
          delayRemaining
        )
      )
    }
  }
  return null
}

function parseUploadMetadata(metadata: unknown) {
  return metadata && typeof metadata === "object"
    ? Object.fromEntries(
        Object.entries(metadata as Record<string, unknown>).map(([key, value]) => [key, String(value)])
      )
    : undefined
}

async function authorizeUploadTarget(request: Request, projectId: string, bucketName: string) {
  const authorized = await authorizeProjectRequest(request, projectId, "upload")
  if ("response" in authorized) return { response: authorized.response }
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return { response: r2.response }
  return { authorized, r2 }
}

export async function startProjectUpload(
  request: Request,
  body: UploadStartBody,
  options?: { forceMultipart?: boolean }
) {
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const bucketName =
    (typeof body.bucket === "string" ? body.bucket.trim() : "") || projectBucketFromRequest(request)
  const key = typeof body.key === "string" ? body.key.trim() : ""

  if (!key || key.endsWith("/")) {
    return NextResponse.json({ error: "Valid object key is required" }, { status: 400 })
  }

  const resolved = await authorizeUploadTarget(request, projectId, bucketName)
  if ("response" in resolved) return resolved.response

  try {
    await assertProjectObjectWritable(
      resolved.authorized.auth.project.id,
      resolved.r2.bucketName,
      key,
      request.headers.get("x-drive-lock-token")
    )
  } catch {
    return NextResponse.json({ error: "Object is locked" }, { status: 409 })
  }

  const metadata = parseUploadMetadata(body.metadata)
  const multipart = options?.forceMultipart === true || body.multipart === true

  if (multipart) {
    const upload = await r2CreateMultipartUpload(resolved.r2.config, resolved.r2.bucketName, key, {
      contentType: typeof body.contentType === "string" ? body.contentType : undefined,
      metadata,
    })
    after(() => recordProjectApiEvent({
      project: resolved.authorized.auth.project,
      apiKeyId: resolved.authorized.auth.apiKey.id,
      action: "file.multipart.create",
      objectKey: key,
      request,
      metadata: { bucketName: resolved.r2.bucketName },
    }))
    return NextResponse.json({
      uploadType: "multipart",
      key,
      bucketName: resolved.r2.bucketName,
      uploadId: upload.UploadId,
    })
  }

  const expiresInSeconds = Math.max(
    30,
    Math.min(3600, Number(body.expiresInSeconds ?? 900))
  )
  const uploadUrl = await r2CreateSignedUploadUrl(resolved.r2.config, resolved.r2.bucketName, key, {
    expiresInSeconds,
    contentType: typeof body.contentType === "string" ? body.contentType : undefined,
    metadata,
    ifMatch: typeof body.ifMatch === "string" ? body.ifMatch : undefined,
    ifNoneMatch: typeof body.ifNoneMatch === "string" ? body.ifNoneMatch : undefined,
  })
  after(() => recordProjectApiEvent({
    project: resolved.authorized.auth.project,
    apiKeyId: resolved.authorized.auth.apiKey.id,
    action: "file.upload.presign",
    objectKey: key,
    request,
    metadata: { bucketName: resolved.r2.bucketName },
  }))

  return NextResponse.json({
    uploadType: "single",
    method: "PUT",
    url: uploadUrl,
    key,
    bucketName: resolved.r2.bucketName,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    headers: {
      ...(typeof body.contentType === "string" ? { "Content-Type": body.contentType } : {}),
    },
  })
}

export async function completeProjectUpload(request: Request, body: UploadCompleteBody) {
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const bucketName =
    (typeof body.bucket === "string" ? body.bucket.trim() : "") || projectBucketFromRequest(request)
  const key = typeof body.key === "string" ? body.key.trim() : ""

  if (!key || key.endsWith("/")) {
    return NextResponse.json({ error: "Valid object key is required" }, { status: 400 })
  }

  const resolved = await authorizeUploadTarget(request, projectId, bucketName)
  if ("response" in resolved) return resolved.response

  const head = await headUploadedObjectWithRetry(resolved.r2.config, resolved.r2.bucketName, key)
  if (!head) {
    await recordProjectApiEvent({
      project: resolved.authorized.auth.project,
      apiKeyId: resolved.authorized.auth.apiKey.id,
      action: "file.upload.complete",
      objectKey: key,
      request,
      metadata: { bucketName: resolved.r2.bucketName, pending: true },
    }).catch(() => undefined)
    return NextResponse.json(
      {
        ok: true,
        pending: true,
        projectId,
        bucketName: resolved.r2.bucketName,
        key,
        fileId: null,
        size: null,
        etag: null,
        contentType: null,
        metadata: {},
        lastModified: null,
      },
      { status: 202 }
    )
  }

  await recordProjectApiEvent({
    project: resolved.authorized.auth.project,
    apiKeyId: resolved.authorized.auth.apiKey.id,
    action: "file.upload.complete",
    objectKey: key,
    request,
    metadata: { bucketName: resolved.r2.bucketName, size: head.ContentLength ?? 0 },
  })

  return NextResponse.json({
    ok: true,
    projectId,
    bucketName: resolved.r2.bucketName,
    key,
    fileId: null,
    size: head.ContentLength ?? 0,
    etag: head.ETag,
    contentType: head.ContentType,
    metadata: head.Metadata ?? {},
    lastModified: head.LastModified?.toISOString() ?? null,
  })
}
