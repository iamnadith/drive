import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import {
  deleteProjectApiKey,
  getProjectByIdentifier,
  normalizePermissions,
  updateProjectApiKey,
} from "@/lib/projects-store"

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

    const actorUserId = (await cookies()).get("sessionUserId")?.value ?? null
    await recordActivity({
      actorUserId,
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
    const { id, keyId } = await context.params
    const project = await getProjectByIdentifier(id)
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
    await deleteProjectApiKey(project.id, keyId)

    const actorUserId = (await cookies()).get("sessionUserId")?.value ?? null
    await recordActivity({
      actorUserId,
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
