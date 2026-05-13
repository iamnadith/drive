import { NextResponse } from "next/server"
import { authorizeProjectRequest } from "@/lib/project-api-auth"
import {
  getProjectOperationJob,
  processProjectOperationJob,
} from "@/lib/project-operations-store"
import { getProjectByIdentifier } from "@/lib/projects-store"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: string) {
  return UUID_PATTERN.test(value)
}

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
    if (!isUuid(id)) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }

    const job = await getProjectOperationJob(id)
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 })
    const project = await getProjectByIdentifier(job.projectId)
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
    const authorized = await authorizeProjectRequest(_request, project.projectId, "list")
    if ("response" in authorized) return authorized.response
    return NextResponse.json({ job })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to load job") },
      { status: 400 }
    )
  }
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    if (!isUuid(id)) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 })
    }

    const existing = await getProjectOperationJob(id)
    if (!existing) return NextResponse.json({ error: "Job not found" }, { status: 404 })
    const project = await getProjectByIdentifier(existing.projectId)
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
    const authorized = await authorizeProjectRequest(_request, project.projectId, "list")
    if ("response" in authorized) return authorized.response
    const job = await processProjectOperationJob(id)
    return NextResponse.json({ job })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to process job") },
      { status: 400 }
    )
  }
}
