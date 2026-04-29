import { NextResponse } from "next/server"
import { authorizeProjectRequest } from "@/lib/project-api-auth"
import { recordProjectApiEvent } from "@/lib/project-operations-store"
import { revokeProjectFileLink } from "@/lib/projects-store"

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    action?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  if (body.action && body.action !== "revoke") {
    return NextResponse.json({ error: "Unsupported link action" }, { status: 400 })
  }

  const authorized = await authorizeProjectRequest(request, projectId, "revokeLink")
  if ("response" in authorized) return authorized.response

  const link = await revokeProjectFileLink(authorized.auth.project.id, id)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.link.revoke",
    objectKey: link.objectKey,
    request,
    metadata: { linkId: id },
  })
  return NextResponse.json({ link })
}
