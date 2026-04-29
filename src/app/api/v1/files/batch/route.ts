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
    operation?: unknown
    keys?: unknown
    items?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const operation = typeof body.operation === "string" ? body.operation : ""
  const type =
    operation === "delete"
      ? "batch_delete"
      : operation === "copy"
        ? "batch_copy"
        : operation === "move"
          ? "batch_move"
          : null
  if (!type) {
    return NextResponse.json({ error: "operation must be delete, copy, or move" }, { status: 400 })
  }
  const permission = operation === "delete" ? "delete" : operation === "copy" ? "read" : "rename"
  const authorized = await authorizeProjectRequest(request, projectId, permission)
  if ("response" in authorized) return authorized.response

  const job = await createProjectOperationJob({
    projectIdentifier: authorized.auth.project.id,
    type,
    payload: {
      keys: Array.isArray(body.keys) ? body.keys : undefined,
      items: Array.isArray(body.items) ? body.items : undefined,
    },
    idempotencyKey: request.headers.get("idempotency-key"),
  })
  void processProjectOperationJob(job.id).catch((error) => {
    console.error("Batch operation job failed:", error)
  })
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: `file.batch.${operation}.queued`,
    status: 202,
    request,
    metadata: { jobId: job.id },
  })
  return NextResponse.json({ job }, { status: 202 })
}
