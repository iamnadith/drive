import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import {
  PROJECT_PERMISSION_PRESETS,
  createProjectApiKey,
  getProjectByIdentifier,
  listProjectApiKeys,
  normalizePermissions,
} from "@/lib/projects-store"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    const keys = await listProjectApiKeys(id)
    return NextResponse.json({ keys })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to load API keys") },
      { status: 400 }
    )
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown
      preset?: unknown
      permissions?: unknown
      expiresAt?: unknown
    }
    const project = await getProjectByIdentifier(id)
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

    const preset =
      typeof body.preset === "string" && PROJECT_PERMISSION_PRESETS[body.preset]
        ? PROJECT_PERMISSION_PRESETS[body.preset]
        : PROJECT_PERMISSION_PRESETS["Read only"]
    const inputPermissions =
      body.permissions && typeof body.permissions === "object"
        ? (body.permissions as Record<string, unknown>)
        : {}
    const permissions = body.permissions
      ? normalizePermissions({ ...preset, ...inputPermissions })
      : preset

    const { apiKey, secret } = await createProjectApiKey({
      projectIdentifier: project.id,
      name: typeof body.name === "string" ? body.name : "API key",
      permissions,
      expiresAt: typeof body.expiresAt === "string" && body.expiresAt ? body.expiresAt : null,
    })

    const actorUserId = (await cookies()).get("sessionUserId")?.value ?? null
    await recordActivity({
      actorUserId,
      action: "project.api_key.created",
      entityType: "project",
      entityId: project.projectId,
      entityLabel: project.name,
      summary: `Created API key ${apiKey.name} for ${project.name}`,
      metadata: { apiKeyId: apiKey.id, keyPrefix: apiKey.keyPrefix },
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ key: apiKey, secret })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to create API key") },
      { status: 400 }
    )
  }
}
