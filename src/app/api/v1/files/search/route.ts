import { NextResponse } from "next/server"
import { authorizeProjectRequest, projectIdFromUrl } from "@/lib/project-api-auth"
import {
  recordProjectApiEvent,
  searchProjectInventory,
} from "@/lib/project-operations-store"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectId = projectIdFromUrl(request)
  const authorized = await authorizeProjectRequest(request, projectId, "list")
  if ("response" in authorized) return authorized.response

  const results = await searchProjectInventory({
    projectId: authorized.auth.project.id,
    q: url.searchParams.get("q") ?? undefined,
    prefix: url.searchParams.get("prefix") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100),
  })
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.search",
    request,
    metadata: { q: url.searchParams.get("q") ?? "", prefix: url.searchParams.get("prefix") ?? "" },
  })
  return NextResponse.json({ projectId, ...results })
}
