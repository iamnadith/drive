import { after, NextResponse } from "next/server"
import { authorizeProjectRequest, getActiveProjectBucketR2Config, projectBucketFromRequest, projectIdFromUrl } from "@/lib/project-api-auth"
import { buildProjectStorageObjectUrl } from "@/lib/project-storage-gateway"
import { assertProjectObjectWritable, markTrackedBucketObjectDeleted, recordProjectApiEvent } from "@/lib/project-operations-store"
import { r2DeleteObject, r2HeadObject, r2PutObject } from "@/lib/r2-s3"

const SYSTEM_DERIVATIVE_KEY_REGEX = /-(poster|preview|stream|subtitles(?:\.[a-z0-9_-]+)?)\.[a-z0-9]{1,8}$/i

function keyFromParams(parts: string[]) {
  return parts.map((part) => decodeURIComponent(part)).join("/").trim().replace(/^\/+/, "")
}

function shouldBypassWriteLockForKey(key: string) {
  return SYSTEM_DERIVATIVE_KEY_REGEX.test(key)
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

  const head = await r2HeadObject(r2.config, r2.bucketName, key).catch(() => null)
  if (!head) {
    return new Response(null, { status: 404 })
  }

  return new Response(null, {
    status: 200,
    headers: {
      ...(typeof head.ContentLength === "number" ? { "Content-Length": String(head.ContentLength) } : {}),
      ...(head.ContentType ? { "Content-Type": head.ContentType } : {}),
      ...(head.ETag ? { ETag: head.ETag } : {}),
      "Cache-Control": "no-store",
    },
  })
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
    } catch {
      return NextResponse.json({ error: "Object is locked" }, { status: 409 })
    }
  }

  try {
    const bodyBytes = request.body
      ? new Uint8Array(await request.arrayBuffer())
      : ""
    await r2PutObject(r2.config, r2.bucketName, key, bodyBytes, {
      contentType: request.headers.get("content-type") ?? undefined,
    })

    await recordProjectApiEvent({
      project: authorized.auth.project,
      apiKeyId: authorized.auth.apiKey.id,
      action: "storage.object.put",
      objectKey: key,
      request,
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

  if (!shouldBypassWriteLockForKey(key)) {
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
  }

  await r2DeleteObject(r2.config, r2.bucketName, key)
  after(async () => {
    await Promise.allSettled([
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
      }),
    ])
  })

  return NextResponse.json({ ok: true, key, bucketName: r2.bucketName })
}
