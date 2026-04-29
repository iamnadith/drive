import { NextResponse } from "next/server"
import { Readable } from "stream"
import type { ReadableStream as NodeReadableStream } from "stream/web"
import {
  authorizeProjectRequest,
  getActiveProjectR2Config,
} from "@/lib/project-api-auth"
import {
  assertProjectObjectWritable,
  recordProjectApiEvent,
  upsertProjectObjectInventory,
} from "@/lib/project-operations-store"
import { r2HeadObject, r2PutObject } from "@/lib/r2-s3"

export async function POST(request: Request) {
  const formData = await request.formData()
  const projectId =
    String(formData.get("projectId") ?? "").trim() ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const file = formData.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "File is required" }, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "upload")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectR2Config(authorized.auth.project)
  if ("response" in r2) return r2.response

  const explicitKey = String(formData.get("key") ?? "").trim()
  const path = String(formData.get("path") ?? "").replace(/^\/+/, "")
  const normalizedPath = path && !path.endsWith("/") ? `${path}/` : path
  const key = explicitKey || `${normalizedPath}${file.name}`
  if (!key || key.endsWith("/")) {
    return NextResponse.json({ error: "Valid object key is required" }, { status: 400 })
  }
  try {
    await assertProjectObjectWritable(
      authorized.auth.project.id,
      key,
      request.headers.get("x-drive-lock-token")
    )
  } catch {
    return NextResponse.json({ error: "Object is locked" }, { status: 409 })
  }

  const nodeStream = Readable.fromWeb(
    file.stream() as unknown as NodeReadableStream<Uint8Array>
  )
  await r2PutObject(r2.config, authorized.auth.project.bucketName, key, nodeStream, {
    contentType: file.type || "application/octet-stream",
    ifMatch: request.headers.get("if-match") ?? undefined,
    ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
  })
  const head = await r2HeadObject(r2.config, authorized.auth.project.bucketName, key).catch(() => null)
  await upsertProjectObjectInventory({
    projectId: authorized.auth.project.id,
    key,
    size: head?.ContentLength ?? file.size,
    etag: head?.ETag,
    contentType: head?.ContentType ?? file.type,
    metadata: head?.Metadata,
    lastModified: head?.LastModified?.toISOString(),
  }).catch(() => undefined)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.upload",
    objectKey: key,
    request,
    metadata: { size: file.size },
  })

  return NextResponse.json({ ok: true, projectId, key, size: file.size })
}
