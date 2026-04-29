import { NextResponse } from "next/server"
import { authorizeProjectRequest } from "@/lib/project-api-auth"
import {
  createProjectOperationJob,
  processProjectOperationJob,
  recordProjectApiEvent,
} from "@/lib/project-operations-store"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    prefix?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const authorized = await authorizeProjectRequest(request, projectId, "list")
  if ("response" in authorized) return authorized.response

  const prefix = typeof body.prefix === "string" ? body.prefix : ""
  const job = await createProjectOperationJob({
    projectIdentifier: authorized.auth.project.id,
    type: "inventory_scan",
    payload: { prefix },
    idempotencyKey: request.headers.get("idempotency-key"),
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
    metadata: { jobId: job.id, prefix },
  })
  return NextResponse.json({ job }, { status: 202 })
}
