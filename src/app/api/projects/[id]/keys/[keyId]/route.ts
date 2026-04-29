import { NextResponse } from "next/server"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import {
  deleteProjectApiKey,
  getProjectByIdentifier,
  normalizePermissions,
  updateProjectApiKey,
} from "@/lib/projects-store"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; keyId: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id, keyId } = await context.params
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown
      status?: unknown
      expiresAt?: unknown
      permissions?: unknown
    }
    const project = await getProjectByIdentifier(id)
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
    const key = await updateProjectApiKey(project.id, keyId, {
      name: typeof body.name === "string" ? body.name : undefined,
      status:
        body.status === "active" || body.status === "disabled" ? body.status : undefined,
      expiresAt:
        typeof body.expiresAt === "string" || body.expiresAt === null
          ? body.expiresAt
          : undefined,
      permissions: body.permissions ? normalizePermissions(body.permissions) : undefined,
    })

    await recordActivity({
      actorUserId: auth.user.id,
      action: "project.api_key.updated",
      entityType: "project",
      entityId: project.projectId,
      entityLabel: project.name,
      summary: `Updated API key ${key.name} for ${project.name}`,
      metadata: { apiKeyId: key.id, keyPrefix: key.keyPrefix },
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ key })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to update API key") },
      { status: 400 }
    )
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; keyId: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id, keyId } = await context.params
    const project = await getProjectByIdentifier(id)
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
    await deleteProjectApiKey(project.id, keyId)

    await recordActivity({
      actorUserId: auth.user.id,
      action: "project.api_key.deleted",
      entityType: "project",
      entityId: project.projectId,
      entityLabel: project.name,
      summary: `Deleted an API key from ${project.name}`,
      metadata: { apiKeyId: keyId },
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to delete API key") },
      { status: 400 }
    )
  }
}
