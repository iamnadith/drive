import { NextResponse } from "next/server"
import { authorizeProjectRequest, getActiveProjectBucketR2Config, projectBucketFromRequest, projectIdFromUrl } from "@/lib/project-api-auth"
import { buildProjectStorageObjectUrl } from "@/lib/project-storage-gateway"
import { r2ListAllObjects, r2ListObjectsPage } from "@/lib/r2-s3"

export const runtime = "nodejs"
export const maxDuration = 300

export async function GET(request: Request) {
  const url = new URL(request.url)
  const projectId = projectIdFromUrl(request)
  const bucketName = projectBucketFromRequest(request)
  const authorized = await authorizeProjectRequest(request, projectId, "list")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return r2.response
  const requestedLimit = Number(url.searchParams.get("limit") ?? 1_000)
  const maxObjects = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(200_000, Math.floor(requestedLimit)))
    : 1_000

  const prefix = url.searchParams.get("prefix") ?? undefined
  const continuationToken = url.searchParams.get("continuationToken") ?? undefined

  // A continuation token makes inventory consumers resumable. The legacy
  // response (without a token) keeps its bounded all-object behavior so
  // existing dashboard callers retain their current semantics.
  if (url.searchParams.get("paged") === "1") {
    const page = await r2ListObjectsPage(r2.config, r2.bucketName, {
      continuationToken,
      prefix,
      maxKeys: Math.min(maxObjects, 1_000),
    })
    const contents = Array.isArray(page.Contents) ? page.Contents : []
    const nextContinuationToken = typeof page.NextContinuationToken === "string"
      ? page.NextContinuationToken
      : undefined
    return NextResponse.json({
      bucketName: r2.bucketName,
      objects: contents.flatMap((item) => {
        if (typeof item?.Key !== "string" || !item.Key) return []
        return [{
          key: item.Key,
          url: buildProjectStorageObjectUrl(request, r2.bucketName, item.Key),
          fileName: item.Key,
          size: typeof item.Size === "number" ? item.Size : 0,
          uploadedAt: item.LastModified?.toISOString() ?? null,
        }]
      }),
      nextContinuationToken: nextContinuationToken ?? null,
    })
  }

  const objects = await r2ListAllObjects(r2.config, r2.bucketName, {
    prefix,
    maxObjects,
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
