import { NextResponse } from "next/server"
import { authorizeProjectRequest } from "@/lib/project-api-auth"
import {
  getProjectOperationJob,
  processProjectOperationJob,
} from "@/lib/project-operations-store"
import { getProjectByIdentifier } from "@/lib/projects-store"

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  const job = await getProjectOperationJob(id)
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 })
  const project = await getProjectByIdentifier(job.projectId)
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
  const authorized = await authorizeProjectRequest(_request, project.projectId, "list")
  if ("response" in authorized) return authorized.response
  return NextResponse.json({ job })
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  const existing = await getProjectOperationJob(id)
  if (!existing) return NextResponse.json({ error: "Job not found" }, { status: 404 })
  const project = await getProjectByIdentifier(existing.projectId)
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
  const authorized = await authorizeProjectRequest(_request, project.projectId, "list")
  if ("response" in authorized) return authorized.response
  const job = await processProjectOperationJob(id)
  return NextResponse.json({ job })
}
