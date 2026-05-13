import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
} from "@/lib/project-api-auth"
import {
  recordProjectApiEvent,
  syncTrackedBucketObject,
} from "@/lib/project-operations-store"
import { r2PutObject } from "@/lib/r2-s3"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    key?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const bucketName =
    (typeof (body as { bucket?: unknown }).bucket === "string"
      ? String((body as { bucket?: unknown }).bucket).trim()
      : "") || projectBucketFromRequest(request)
  const rawKey = typeof body.key === "string" ? body.key.trim().replace(/^\/+/, "") : ""
  const key = rawKey ? (rawKey.endsWith("/") ? rawKey : `${rawKey}/`) : ""
  if (!key) return NextResponse.json({ error: "Folder key is required" }, { status: 400 })

  const authorized = await authorizeProjectRequest(request, projectId, "createFolder")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return r2.response

  await r2PutObject(r2.config, r2.bucketName, key, "")
  const trackedObject = await syncTrackedBucketObject({
    config: r2.config,
    projectId: authorized.auth.project.id,
    bucketName: r2.bucketName,
    key,
  }).catch(() => undefined)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "folder.create",
    objectKey: key,
    request,
    metadata: trackedObject?.fileId ? { fileId: trackedObject.fileId } : undefined,
  })
  return NextResponse.json({ ok: true, projectId, key, fileId: trackedObject?.fileId ?? null })
}
