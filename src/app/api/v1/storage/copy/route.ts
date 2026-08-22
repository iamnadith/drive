import { after, NextResponse } from "next/server"
import { authorizeProjectRequest, getActiveProjectBucketR2Config, projectBucketFromRequest } from "@/lib/project-api-auth"
import { buildProjectStorageObjectUrl } from "@/lib/project-storage-gateway"
import { getProjectObjectInventoryByFileId, recordProjectApiEvent, syncTrackedBucketObject } from "@/lib/project-operations-store"
import { r2CopyObject } from "@/lib/r2-s3"

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    bucket?: unknown
    fromKey?: unknown
    fileId?: unknown
    toKey?: unknown
  }
  const projectId = (typeof body.projectId === "string" ? body.projectId.trim() : "") || request.headers.get("x-drive-project")?.trim() || ""
  const bucketName = (typeof body.bucket === "string" ? body.bucket.trim() : "") || projectBucketFromRequest(request)
  const fileId = typeof body.fileId === "string" ? body.fileId.trim() : ""
  const directFromKey = typeof body.fromKey === "string" ? body.fromKey.trim() : ""
  const toKey = typeof body.toKey === "string" ? body.toKey.trim() : ""
  if (!toKey) return NextResponse.json({ error: "Destination key is required" }, { status: 400 })

  const authorized = await authorizeProjectRequest(request, projectId, "read")
  if ("response" in authorized) return authorized.response
  const object = fileId ? await getProjectObjectInventoryByFileId(authorized.auth.project.id, fileId) : null
  if (fileId && !object) return NextResponse.json({ error: "File not found" }, { status: 404 })
  const fromKey = object?.key ?? directFromKey
  if (!fromKey) return NextResponse.json({ error: "Source key or fileId is required" }, { status: 400 })
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, object?.bucketName ?? bucketName)
  if ("response" in r2) return r2.response

  let copied: Awaited<ReturnType<typeof r2CopyObject>>
  try {
    copied = await r2CopyObject(r2.config, r2.bucketName, fromKey, toKey)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "Storage copy failed")
    const notReady = message.startsWith("Copied object is not readable after copy:")
    return NextResponse.json(
      {
        error: message,
        code: notReady ? "COPY_NOT_READY" : "COPY_FAILED",
        retryable: notReady,
      },
      { status: notReady ? 503 : 502 },
    )
  }
  // The caller needs the verified copy immediately. Inventory reconciliation
  // and audit logging are bookkeeping and can involve a second database
  // round-trip; doing them before the response made valid copies exceed the
  // worker's 15-second request deadline. Keep those side effects durable but
  // outside the copy critical path.
  after(async () => {
    const trackedObject = await syncTrackedBucketObject({
      config: r2.config,
      projectId: authorized.auth.project.id,
      bucketName: r2.bucketName,
      key: toKey,
    }).catch(() => undefined)

    await recordProjectApiEvent({
      project: authorized.auth.project,
      apiKeyId: authorized.auth.apiKey.id,
      action: "storage.object.copy",
      objectKey: fromKey,
      request,
      metadata: { toKey, ...(trackedObject?.fileId ? { fileId: trackedObject.fileId } : {}) },
    }).catch(() => undefined)
  })

  return NextResponse.json({
    ok: true,
    fromKey,
    toKey,
    bucketName: r2.bucketName,
    fileId: null,
    url: buildProjectStorageObjectUrl(request, r2.bucketName, toKey),
    copyResult: copied ? true : true,
  })
}
