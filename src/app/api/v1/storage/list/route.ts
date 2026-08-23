import { NextResponse } from "next/server"
import { authorizeProjectRequest, getActiveProjectBucketR2Config, projectBucketFromRequest, projectIdFromUrl } from "@/lib/project-api-auth"
import { buildProjectStorageObjectUrl } from "@/lib/project-storage-gateway"
import { r2ListAllObjects, r2ListObjectsPage } from "@/lib/r2-s3"

export const runtime = "nodejs"
export const maxDuration = 300

type CachedStoragePage = {
  expiresAt: number
  page: Awaited<ReturnType<typeof r2ListObjectsPage>>
}

// The panel can request the same page from several components during a
// refresh. Coalesce identical R2 list calls and retain only a tiny, short-lived
// page cache; mutations remain immediately visible after the one-second TTL.
const STORAGE_PAGE_CACHE_TTL_MS = 1_000
const STORAGE_PAGE_CACHE_MAX = 64
const storagePageCache = new Map<string, CachedStoragePage>()
const storagePageInflight = new Map<string, Promise<CachedStoragePage["page"]>>()

function storagePageCacheKey(input: {
  projectId: string
  bucketName: string
  prefix?: string
  continuationToken?: string
  maxKeys: number
}) {
  return [
    input.projectId,
    input.bucketName,
    input.prefix ?? "",
    input.continuationToken ?? "",
    input.maxKeys,
  ].join("\u0000")
}

async function getCachedStoragePage(
  key: string,
  load: () => Promise<CachedStoragePage["page"]>
) {
  const cached = storagePageCache.get(key)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.page
  if (cached) storagePageCache.delete(key)

  const active = storagePageInflight.get(key)
  if (active) return active

  const request = load()
    .then((page) => {
      if (storagePageCache.size >= STORAGE_PAGE_CACHE_MAX) {
        const oldest = storagePageCache.keys().next().value
        if (oldest) storagePageCache.delete(oldest)
      }
      storagePageCache.set(key, { page, expiresAt: Date.now() + STORAGE_PAGE_CACHE_TTL_MS })
      return page
    })
    .finally(() => {
      storagePageInflight.delete(key)
    })
  storagePageInflight.set(key, request)
  return request
}

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
    const maxKeys = Math.min(maxObjects, 1_000)
    const page = await getCachedStoragePage(
      storagePageCacheKey({
        projectId: authorized.auth.project.id,
        bucketName: r2.bucketName,
        continuationToken,
        prefix,
        maxKeys,
      }),
      () => r2ListObjectsPage(r2.config, r2.bucketName, {
        continuationToken,
        prefix,
        maxKeys,
      })
    )
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
    }, { headers: { "Cache-Control": "private, max-age=1, stale-while-revalidate=1" } })
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
