import { NextResponse } from "next/server"
import { validateProjectListRequest } from "@/lib/project-api-auth"

export async function GET(request: Request) {
  const result = await validateProjectListRequest(request)
  if ("response" in result) return result.response

  return NextResponse.json({
    projects: result.auth.projects.map(({ project, permissions }) => ({
      projectId: project.projectId,
      name: project.name,
      bucketName: project.bucketName,
      permissions,
    })),
  })
}
