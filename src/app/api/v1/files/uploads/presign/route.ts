import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectR2Config,
} from "@/lib/project-api-auth"
import { assertProjectObjectWritable, recordProjectApiEvent } from "@/lib/project-operations-store"
import { r2CreateSignedUploadUrl } from "@/lib/r2-s3"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    key?: unknown
    contentType?: unknown
    expiresInSeconds?: unknown
    ifMatch?: unknown
    ifNoneMatch?: unknown
    metadata?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const key = typeof body.key === "string" ? body.key.trim() : ""
  if (!key || key.endsWith("/")) {
    return NextResponse.json({ error: "Valid object key is required" }, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "upload")
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

  const expiresInSeconds = Math.max(
    30,
    Math.min(3600, Number(body.expiresInSeconds ?? 900))
  )
  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? Object.fromEntries(
          Object.entries(body.metadata as Record<string, unknown>).map(([k, v]) => [k, String(v)])
        )
      : undefined
  const uploadUrl = await r2CreateSignedUploadUrl(
    r2.config,
    authorized.auth.project.bucketName,
    key,
    {
      expiresInSeconds,
      contentType: typeof body.contentType === "string" ? body.contentType : undefined,
      metadata,
      ifMatch: typeof body.ifMatch === "string" ? body.ifMatch : undefined,
      ifNoneMatch: typeof body.ifNoneMatch === "string" ? body.ifNoneMatch : undefined,
    }
  )
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.upload.presign",
    objectKey: key,
    request,
  })
  return NextResponse.json({
    method: "PUT",
    url: uploadUrl,
    key,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    headers: {
      ...(typeof body.contentType === "string" ? { "Content-Type": body.contentType } : {}),
    },
  })
}
