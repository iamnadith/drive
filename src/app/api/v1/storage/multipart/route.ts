import { NextResponse } from "next/server"

import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
  projectIdFromUrl,
} from "@/lib/project-api-auth"
import { recordProjectApiEvent, syncTrackedBucketObject } from "@/lib/project-operations-store"
import {
  r2AbortMultipartUpload,
  r2CompleteMultipartUpload,
  r2CreateMultipartUpload,
  r2CreateSignedMultipartPartUrl,
} from "@/lib/r2-s3"

type MultipartAction = "start" | "part" | "complete" | "abort"

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeMultipartEtag(value: unknown) {
  const normalized = stringValue(value).replace(/^W\//, "")
  if (!normalized) return ""
  return normalized.startsWith('"') ? normalized : `"${normalized.replace(/^"|"$/g, "")}"`
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown
    projectId?: unknown
    bucket?: unknown
    key?: unknown
    uploadId?: unknown
    partNumber?: unknown
    contentType?: unknown
    expiresInSeconds?: unknown
    parts?: unknown
  }

  const action = stringValue(body.action) as MultipartAction
  const projectId = stringValue(body.projectId) || projectIdFromUrl(request)
  const bucketName = stringValue(body.bucket) || projectBucketFromRequest(request)
  const key = stringValue(body.key)

  if (!action || !["start", "part", "complete", "abort"].includes(action)) {
    return NextResponse.json({ error: "Valid multipart action is required" }, { status: 400 })
  }
  if (!key || key.endsWith("/")) {
    return NextResponse.json({ error: "Valid object key is required" }, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "upload")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return r2.response

  if (action === "start") {
    const upload = await r2CreateMultipartUpload(r2.config, r2.bucketName, key, {
      contentType: stringValue(body.contentType) || undefined,
    })
    await recordProjectApiEvent({
      project: authorized.auth.project,
      apiKeyId: authorized.auth.apiKey.id,
      action: "file.multipart.create",
      objectKey: key,
      request,
      metadata: { bucketName: r2.bucketName },
    })
    return NextResponse.json({
      ok: true,
      action,
      key,
      bucketName: r2.bucketName,
      uploadId: upload.UploadId,
    })
  }

  const uploadId = stringValue(body.uploadId)
  if (!uploadId) {
    return NextResponse.json({ error: "uploadId is required" }, { status: 400 })
  }

  if (action === "part") {
    const partNumber = Number(body.partNumber)
    if (!Number.isInteger(partNumber) || partNumber <= 0) {
      return NextResponse.json({ error: "Valid partNumber is required" }, { status: 400 })
    }
    const expiresInSeconds = Math.max(30, Math.min(3600, Number(body.expiresInSeconds ?? 900)))
    const url = await r2CreateSignedMultipartPartUrl(
      r2.config,
      r2.bucketName,
      key,
      uploadId,
      partNumber,
      expiresInSeconds
    )
    return NextResponse.json({
      ok: true,
      action,
      key,
      bucketName: r2.bucketName,
      uploadId,
      partNumber,
      url,
    })
  }

  if (action === "abort") {
    await r2AbortMultipartUpload(r2.config, r2.bucketName, key, uploadId)
    await recordProjectApiEvent({
      project: authorized.auth.project,
      apiKeyId: authorized.auth.apiKey.id,
      action: "file.multipart.abort",
      objectKey: key,
      request,
      metadata: { bucketName: r2.bucketName },
    })
    return NextResponse.json({ ok: true, action, key, bucketName: r2.bucketName, uploadId })
  }

  const parts = Array.isArray(body.parts)
    ? body.parts
        .map((part) => {
          const item = part as { partNumber?: unknown; etag?: unknown }
          return { partNumber: Number(item.partNumber), etag: normalizeMultipartEtag(item.etag) }
        })
        .filter((part) => Number.isInteger(part.partNumber) && part.partNumber > 0 && part.etag)
    : []
  if (parts.length === 0) {
    return NextResponse.json({ error: "Multipart parts are required" }, { status: 400 })
  }

  await r2CompleteMultipartUpload(r2.config, r2.bucketName, key, uploadId, parts)
  const trackedObject = await syncTrackedBucketObject({
    config: r2.config,
    projectId: authorized.auth.project.id,
    bucketName: r2.bucketName,
    key,
  }).catch(() => undefined)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.multipart.complete",
    objectKey: key,
    request,
    metadata: { bucketName: r2.bucketName, parts: parts.length },
  })

  return NextResponse.json({
    ok: true,
    action,
    key,
    bucketName: r2.bucketName,
    uploadId,
    fileId: trackedObject?.fileId ?? null,
  })
}
