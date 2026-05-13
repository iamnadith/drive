import { NextResponse } from "next/server"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import {
  createProjectRecord,
  generateProjectId,
  listProjects,
} from "@/lib/projects-store"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? fallback)
      : fallback
  return message
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const projects = await listProjects()
    return NextResponse.json({ projects })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to load projects") },
      { status: 400 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown
    }
    const name = typeof body.name === "string" ? body.name.trim() : ""
    if (!name) {
      return NextResponse.json({ error: "Project name is required" }, { status: 400 })
    }

    const projectId = generateProjectId()

    const project = await createProjectRecord({
      name,
      projectId,
    })

    await recordActivity({
      actorUserId: auth.user.id,
      action: "project.created",
      entityType: "project",
      entityId: project.projectId,
      entityLabel: project.name,
      summary: `Created project ${project.name}`,
      detail: "Project created without bucket assignment.",
      after: { project },
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ project })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to create project") },
      { status: 400 }
    )
  }
}
