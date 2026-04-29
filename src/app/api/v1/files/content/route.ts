import { NextResponse } from "next/server"
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

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    key?: unknown
    content?: unknown
    contentType?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const key = typeof body.key === "string" ? body.key.trim() : ""
  if (!key || key.endsWith("/")) {
    return NextResponse.json({ error: "Valid object key is required" }, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "write")
  if ("response" in authorized) return authorized.response
  try {
    await assertProjectObjectWritable(
      authorized.auth.project.id,
      key,
      request.headers.get("x-drive-lock-token")
    )
  } catch {
    return NextResponse.json({ error: "Object is locked" }, { status: 409 })
  }
  const r2 = await getActiveProjectR2Config(authorized.auth.project)
  if ("response" in r2) return r2.response

  const content =
    typeof body.content === "string"
      ? body.content
      : body.content === undefined || body.content === null
        ? ""
        : JSON.stringify(body.content)

  await r2PutObject(r2.config, authorized.auth.project.bucketName, key, content, {
    contentType:
      typeof body.contentType === "string" && body.contentType.trim()
        ? body.contentType.trim()
        : "text/plain; charset=utf-8",
    ifMatch: request.headers.get("if-match") ?? undefined,
    ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
  })
  const head = await r2HeadObject(r2.config, authorized.auth.project.bucketName, key).catch(() => null)
  await upsertProjectObjectInventory({
    projectId: authorized.auth.project.id,
    key,
    size: head?.ContentLength ?? Buffer.byteLength(content),
    etag: head?.ETag,
    contentType: head?.ContentType,
    metadata: head?.Metadata,
    lastModified: head?.LastModified?.toISOString(),
  }).catch(() => undefined)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.write",
    objectKey: key,
    request,
  })

  return NextResponse.json({ ok: true, projectId, key })
}
