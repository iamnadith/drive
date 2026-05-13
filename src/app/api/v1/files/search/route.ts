import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  projectBucketFromRequest,
  projectIdFromUrl,
  resolveProjectBucketName,
} from "@/lib/project-api-auth"
import {
  recordProjectApiEvent,
  searchProjectInventory,
} from "@/lib/project-operations-store"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectId = projectIdFromUrl(request)
  const bucketName = projectBucketFromRequest(request)
  const authorized = await authorizeProjectRequest(request, projectId, "list")
  if ("response" in authorized) return authorized.response
  const resolvedBucket = await resolveProjectBucketName(authorized.auth.project, bucketName)
  if ("response" in resolvedBucket) return resolvedBucket.response

  const results = await searchProjectInventory({
    projectId: authorized.auth.project.id,
    bucketName: resolvedBucket.bucketName,
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
    metadata: {
      bucketName: resolvedBucket.bucketName,
      q: url.searchParams.get("q") ?? "",
      prefix: url.searchParams.get("prefix") ?? "",
    },
  })
  return NextResponse.json({ projectId, bucketName: resolvedBucket.bucketName, ...results })
}
