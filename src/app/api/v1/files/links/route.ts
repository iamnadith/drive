import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
} from "@/lib/project-api-auth"
import { getPublicOrigin } from "@/lib/public-origin"
import { recordProjectApiEvent } from "@/lib/project-operations-store"
import { createProjectFileLink } from "@/lib/projects-store"
import { r2CreateSignedDownloadUrl } from "@/lib/r2-s3"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    key?: unknown
    bucket?: unknown
    mode?: unknown
    expiresAt?: unknown
    expiresInSeconds?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const key = typeof body.key === "string" ? body.key.trim() : ""
  const bucketName =
    (typeof body.bucket === "string" ? body.bucket.trim() : "") ||
    projectBucketFromRequest(request)
  const mode = body.mode === "permanent" ? "permanent" : "expiring"
  if (!key) return NextResponse.json({ error: "Object key is required" }, { status: 400 })

  const permission = mode === "permanent" ? "createPermanentLink" : "createExpiringLink"
  const authorized = await authorizeProjectRequest(request, projectId, permission)
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return r2.response

  const expiresInSeconds = Math.max(
    30,
    Math.min(
      mode === "permanent" ? 60 * 60 * 24 * 365 : 3600,
      Number(body.expiresInSeconds ?? (mode === "permanent" ? 60 * 60 * 24 * 365 : 900))
    )
  )
  const expiresAt =
    typeof body.expiresAt === "string" && body.expiresAt
      ? body.expiresAt
      : new Date(Date.now() + expiresInSeconds * 1000).toISOString()

  if (mode === "expiring") {
    const signedUrl = await r2CreateSignedDownloadUrl(
      r2.config,
      r2.bucketName,
      key,
      { expiresInSeconds }
    )
    const { link } = await createProjectFileLink({
      projectIdentifier: authorized.auth.project.id,
      objectKey: key,
      bucketName: r2.bucketName,
      mode,
      expiresAt,
    })
    await recordProjectApiEvent({
      project: authorized.auth.project,
      apiKeyId: authorized.auth.apiKey.id,
      action: "file.link.expiring.create",
      objectKey: key,
      request,
      metadata: { linkId: link.id },
    })
    return NextResponse.json({ link, url: signedUrl, expiresAt })
  }

  const { link, token } = await createProjectFileLink({
    projectIdentifier: authorized.auth.project.id,
    objectKey: key,
    bucketName: r2.bucketName,
    mode,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
  })
  const publicUrl = `${getPublicOrigin(request)}/api/public/files/${encodeURIComponent(token)}`
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.link.permanent.create",
    objectKey: key,
    request,
    metadata: { linkId: link.id },
  })
  return NextResponse.json({ link, url: publicUrl, expiresAt: link.expiresAt ?? null })
}
