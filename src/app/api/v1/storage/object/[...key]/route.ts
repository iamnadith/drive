import { after, NextResponse } from "next/server"
import { authorizeProjectRequest, getActiveProjectBucketR2Config, projectBucketFromRequest, projectIdFromUrl } from "@/lib/project-api-auth"
import { buildProjectStorageObjectUrl } from "@/lib/project-storage-gateway"
import { assertProjectObjectWritable, clearProjectObjectLock, markTrackedBucketObjectDeleted, recordProjectApiEvent } from "@/lib/project-operations-store"
import { projectObjectLockResponse } from "@/lib/project-object-lock"
import { r2DeleteObject, r2HeadObject, r2PutObject } from "@/lib/r2-s3"
import { isSystemDerivativeKey } from "@/lib/storage-delivery.cjs"
import { rejectDisallowedBucketDeliveryOrigin } from "@/lib/bucket-delivery-origin-guard"
import { createStorageObjectMetadataHeaders } from "@/lib/storage-object-metadata.cjs"

function keyFromParams(parts: string[]) {
  return parts.map((part) => decodeURIComponent(part)).join("/").trim().replace(/^\/+/, "")
}

function shouldBypassWriteLockForKey(key: string) {
  return isSystemDerivativeKey(key)
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ key: string[] }> }
) {
  const { key: keyParts } = await context.params
  const projectId = projectIdFromUrl(request)
  const bucketName = projectBucketFromRequest(request)
  const key = keyFromParams(keyParts)
  if (!key || key.endsWith("/")) {
    return new Response(null, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "read")
  if ("response" in authorized) {
    return new Response(null, { status: authorized.response?.status ?? 401 })
  }
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) {
    return new Response(null, { status: r2.response?.status ?? 409 })
  }
  const originRejection = await rejectDisallowedBucketDeliveryOrigin(request, r2.bucketName)
  if (originRejection) return new Response(null, { status: originRejection.status })

  const head = await r2HeadObject(r2.config, r2.bucketName, key).catch(() => null)
  if (!head) {
    return new Response(null, { status: 404 })
  }

  // Build this as a Headers instance so the conditional metadata fields are
  // accepted consistently by the Next.js/Vercel Response type checker.
  const headers = new Headers({ "Cache-Control": "no-store" })
  const metadataHeaders = createStorageObjectMetadataHeaders(head.ContentLength)
  for (const [name, value] of Object.entries(metadataHeaders)) {
    if (value !== undefined) headers.set(name, value)
  }
  if (head.ContentType) headers.set("Content-Type", head.ContentType)
  if (head.ETag) headers.set("ETag", head.ETag)

  return new Response(null, { status: 200, headers })
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ key: string[] }> }
) {
  const { key: keyParts } = await context.params
  const projectId = projectIdFromUrl(request)
  const bucketName = projectBucketFromRequest(request)
  const key = keyFromParams(keyParts)
  if (!key || key.endsWith("/")) {
    return NextResponse.json({ error: "Valid object key is required" }, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "write")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return r2.response

  if (!shouldBypassWriteLockForKey(key)) {
    try {
      await assertProjectObjectWritable(
        authorized.auth.project.id,
        r2.bucketName,
        key,
        request.headers.get("x-drive-lock-token")
      )
    } catch (error) {
      return projectObjectLockResponse(error, {
        operation: "storage.object.put",
        projectId: authorized.auth.project.id,
        bucketName: r2.bucketName,
        key,
      })
    }
  }

  try {
    const bodyBytes = request.body
      ? new Uint8Array(await request.arrayBuffer())
      : ""
    await r2PutObject(r2.config, r2.bucketName, key, bodyBytes, {
      contentType: request.headers.get("content-type") ?? undefined,
    })

    after(async () => {
      await recordProjectApiEvent({
        project: authorized.auth.project,
        apiKeyId: authorized.auth.apiKey.id,
        action: "storage.object.put",
        objectKey: key,
        request,
      })
    })

    return NextResponse.json({
      ok: true,
      key,
      bucketName: r2.bucketName,
      fileId: null,
      url: buildProjectStorageObjectUrl(request, r2.bucketName, key),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to upload object"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ key: string[] }> }
) {
  const { key: keyParts } = await context.params
  const projectId = projectIdFromUrl(request)
  const bucketName = projectBucketFromRequest(request)
  const key = keyFromParams(keyParts)
  if (!key) return NextResponse.json({ error: "Object key is required" }, { status: 400 })

  const authorized = await authorizeProjectRequest(request, projectId, "delete")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return r2.response

  const forceDelete = request.headers.get("x-drive-force-delete")?.toLowerCase() === "true"

  if (!forceDelete && !shouldBypassWriteLockForKey(key)) {
    try {
      await assertProjectObjectWritable(
        authorized.auth.project.id,
        r2.bucketName,
        key,
        request.headers.get("x-drive-lock-token")
      )
    } catch (error) {
      return projectObjectLockResponse(error, {
        operation: "storage.object.delete",
        projectId: authorized.auth.project.id,
        bucketName: r2.bucketName,
        key,
      })
    }
  }

  await r2DeleteObject(r2.config, r2.bucketName, key)
  after(async () => {
    await Promise.allSettled([
      ...(forceDelete
        ? [clearProjectObjectLock({
            projectId: authorized.auth.project.id,
            bucketName: r2.bucketName,
            key,
          })]
        : []),
      markTrackedBucketObjectDeleted({
        projectId: authorized.auth.project.id,
        bucketName: r2.bucketName,
        key,
      }),
      recordProjectApiEvent({
        project: authorized.auth.project,
        apiKeyId: authorized.auth.apiKey.id,
        action: "storage.object.delete",
        objectKey: key,
        request,
        metadata: { forceDelete },
      }),
    ])
  })

  return NextResponse.json({ ok: true, key, bucketName: r2.bucketName })
}
