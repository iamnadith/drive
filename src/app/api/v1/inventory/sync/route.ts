import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  projectBucketFromRequest,
  resolveProjectBucketName,
} from "@/lib/project-api-auth"
import {
  createProjectOperationJob,
  processProjectOperationJob,
  recordProjectApiEvent,
} from "@/lib/project-operations-store"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    bucket?: unknown
    prefix?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const bucketName =
    (typeof body.bucket === "string" ? body.bucket.trim() : "") || projectBucketFromRequest(request)
  const authorized = await authorizeProjectRequest(request, projectId, "list")
  if ("response" in authorized) return authorized.response
  const resolvedBucket = await resolveProjectBucketName(authorized.auth.project, bucketName)
  if ("response" in resolvedBucket) return resolvedBucket.response
  const idempotencyKey = request.headers.get("idempotency-key")?.trim()

  const prefix = typeof body.prefix === "string" ? body.prefix : ""
  const job = await createProjectOperationJob({
    projectIdentifier: authorized.auth.project.id,
    type: "inventory_scan",
    payload: { prefix, bucketName: resolvedBucket.bucketName },
    idempotencyKey: idempotencyKey ? `${resolvedBucket.bucketName}:${idempotencyKey}` : undefined,
  })
  void processProjectOperationJob(job.id).catch((error) => {
    console.error("Inventory sync job failed:", error)
  })
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "inventory.sync.queued",
    status: 202,
    request,
    metadata: { jobId: job.id, bucketName: resolvedBucket.bucketName, prefix },
  })
  return NextResponse.json({ job }, { status: 202 })
}
