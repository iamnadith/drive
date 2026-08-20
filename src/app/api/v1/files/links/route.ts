import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
} from "@/lib/project-api-auth"
import { getPublicOrigin } from "@/lib/public-origin"
import {
  getProjectObjectInventoryByFileId,
  getProjectObjectInventoryByKey,
  recordProjectApiEvent,
} from "@/lib/project-operations-store"
import { createProjectFileLink } from "@/lib/projects-store"
import { r2CreateSignedDownloadUrl } from "@/lib/r2-s3"
import { rejectDisallowedBucketDeliveryOrigin } from "@/lib/bucket-delivery-origin-guard"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    fileId?: unknown
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
  const fileId = typeof body.fileId === "string" ? body.fileId.trim() : ""
  const key = typeof body.key === "string" ? body.key.trim() : ""
  const bucketName =
    (typeof body.bucket === "string" ? body.bucket.trim() : "") ||
    projectBucketFromRequest(request)
  const mode = body.mode === "permanent" ? "permanent" : "expiring"
  if (!key && !fileId) {
    return NextResponse.json({ error: "Object key or fileId is required" }, { status: 400 })
  }

  const permission = mode === "permanent" ? "createPermanentLink" : "createExpiringLink"
  const authorized = await authorizeProjectRequest(request, projectId, permission)
  if ("response" in authorized) return authorized.response
  const directObject = fileId
    ? await getProjectObjectInventoryByFileId(authorized.auth.project.id, fileId)
    : null
  if (fileId && !directObject) return NextResponse.json({ error: "File not found" }, { status: 404 })
  const resolvedKey = directObject?.key ?? key
  const resolvedBucketName = directObject?.bucketName ?? bucketName
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, resolvedBucketName)
  if ("response" in r2) return r2.response
  const originRejection = await rejectDisallowedBucketDeliveryOrigin(request, r2.bucketName)
  if (originRejection) return originRejection
  const trackedObject =
    directObject ??
    (resolvedKey
      ? await getProjectObjectInventoryByKey(authorized.auth.project.id, r2.bucketName, resolvedKey)
      : null)

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
      resolvedKey,
      { expiresInSeconds }
    )
    const { link } = await createProjectFileLink({
      projectIdentifier: authorized.auth.project.id,
      fileId: trackedObject?.fileId,
      objectKey: resolvedKey,
      bucketName: r2.bucketName,
      mode,
      expiresAt,
    })
    await recordProjectApiEvent({
      project: authorized.auth.project,
      apiKeyId: authorized.auth.apiKey.id,
      action: "file.link.expiring.create",
      objectKey: resolvedKey,
      request,
      metadata: { linkId: link.id, ...(trackedObject?.fileId ? { fileId: trackedObject.fileId } : {}) },
    })
    return NextResponse.json({ link, url: signedUrl, expiresAt, fileId: trackedObject?.fileId ?? null })
  }

  const { link, token } = await createProjectFileLink({
    projectIdentifier: authorized.auth.project.id,
    fileId: trackedObject?.fileId,
    objectKey: resolvedKey,
    bucketName: r2.bucketName,
    mode,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
  })
  const publicUrl = `${getPublicOrigin(request)}/api/public/files/${encodeURIComponent(token)}`
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.link.permanent.create",
    objectKey: resolvedKey,
    request,
    metadata: { linkId: link.id, ...(trackedObject?.fileId ? { fileId: trackedObject.fileId } : {}) },
  })
  return NextResponse.json({ link, url: publicUrl, expiresAt: link.expiresAt ?? null, fileId: trackedObject?.fileId ?? null })
}
