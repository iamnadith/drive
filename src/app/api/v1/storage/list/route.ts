import { NextResponse } from "next/server"
import { authorizeProjectRequest, getActiveProjectBucketR2Config, projectBucketFromRequest, projectIdFromUrl } from "@/lib/project-api-auth"
import { buildProjectStorageObjectUrl } from "@/lib/project-storage-gateway"
import { r2ListAllObjects } from "@/lib/r2-s3"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectId = projectIdFromUrl(request)
  const bucketName = projectBucketFromRequest(request)
  const authorized = await authorizeProjectRequest(request, projectId, "list")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return r2.response

  const objects = await r2ListAllObjects(r2.config, r2.bucketName, {
    prefix: url.searchParams.get("prefix") ?? undefined,
    maxObjects: Math.max(1, Math.min(200_000, Number(url.searchParams.get("limit") ?? 50_000))),
  })

  return NextResponse.json({
    bucketName: r2.bucketName,
    objects: objects.map((item) => ({
      key: item.key,
      url: buildProjectStorageObjectUrl(request, r2.bucketName, item.key),
      fileName: item.key,
      size: item.size,
      uploadedAt: item.lastModified ?? null,
    })),
  })
}
