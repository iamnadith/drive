import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
  projectIdFromUrl,
} from "@/lib/project-api-auth"
import { buildProjectStorageObjectUrl } from "@/lib/project-storage-gateway"
import { getRecentProjectObjectKeys } from "@/lib/project-operations-store"
import { r2HeadObject } from "@/lib/r2-s3"

export const runtime = "nodejs"
export const maxDuration = 60

type RecentHead = {
  size: number
  lastModified: string | null
}

type RecentHeadCacheEntry = {
  expiresAt: number
  head: RecentHead | null
}

// Recent is polled by the worker and by the panel at the same time.  Reusing
// a short-lived HEAD result avoids duplicate R2 requests without changing the
// freshness or ordering of the response.  The map is deliberately bounded so
// a long-lived Node process cannot grow with the number of uploaded objects.
const RECENT_HEAD_CACHE_TTL_MS = 15_000
const RECENT_HEAD_MISS_TTL_MS = 3_000
const RECENT_HEAD_CACHE_MAX = 2_048
const recentHeadCache = new Map<string, RecentHeadCacheEntry>()
const recentHeadInflight = new Map<string, Promise<RecentHead | null>>()

function recentHeadCacheKey(accountId: string, bucketName: string, key: string) {
  return `${accountId}:${bucketName}:${key}`
}

async function getRecentHead(
  accountId: string,
  config: Parameters<typeof r2HeadObject>[0],
  bucketName: string,
  key: string
) {
  const cacheKey = recentHeadCacheKey(accountId, bucketName, key)
  const now = Date.now()
  const cached = recentHeadCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.head
  if (cached) recentHeadCache.delete(cacheKey)

  const active = recentHeadInflight.get(cacheKey)
  if (active) return active

  const request = r2HeadObject(config, bucketName, key)
    .then((head) => ({
      size: typeof head.ContentLength === "number" ? head.ContentLength : 0,
      lastModified: head.LastModified?.toISOString() ?? null,
    }))
    .catch(() => null)
    .then((head) => {
      if (recentHeadCache.size >= RECENT_HEAD_CACHE_MAX) {
        const oldest = recentHeadCache.keys().next().value
        if (oldest) recentHeadCache.delete(oldest)
      }
      recentHeadCache.set(cacheKey, {
        expiresAt: Date.now() + (head ? RECENT_HEAD_CACHE_TTL_MS : RECENT_HEAD_MISS_TTL_MS),
        head,
      })
      return head
    })
    .finally(() => {
      recentHeadInflight.delete(cacheKey)
    })
  recentHeadInflight.set(cacheKey, request)
  return request
}

/**
 * Return a small, upload-time ordered window for worker consumers.  R2's
 * ListObjectsV2 endpoint is key ordered, which is correct for a resumable
 * inventory scan but can hide a freshly uploaded key behind thousands of
 * unrelated names.  Upload routes record successful object events, so use
 * those events as a bounded hot path and verify each key still exists in the
 * requested bucket before returning it.
 */
export async function GET(request: Request) {
  try {
    const projectId = projectIdFromUrl(request)
    const bucketName = projectBucketFromRequest(request)
    const authorized = await authorizeProjectRequest(request, projectId, "list")
    if ("response" in authorized) return authorized.response

    const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
    if ("response" in r2) return r2.response

    const requestedLimit = Number(new URL(request.url).searchParams.get("limit") ?? 25)
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
      : 25
    const recent = await getRecentProjectObjectKeys({
      projectId: authorized.auth.project.id,
      limit: Math.min(100, limit * 2),
    })

    // Keep HEAD concurrency bounded; a missing/deleted event must not make the
    // whole recent window fail.
    const objects: Array<{
      key: string
      url: string
      fileName: string
      size: number
      uploadedAt: string | null
    }> = []
    for (let index = 0; index < recent.length && objects.length < limit; index += 8) {
      const batch = recent.slice(index, index + 8)
      const verified = await Promise.all(batch.map(async (row) => {
        const key = row.object_key?.trim()
        if (!key) return null
        const head = await getRecentHead(r2.config.accountId, r2.config, r2.bucketName, key)
        if (!head) return null
        return {
          key,
          url: buildProjectStorageObjectUrl(request, r2.bucketName, key),
          fileName: key,
          size: head.size,
          uploadedAt: head.lastModified ?? row.occurred_at ?? null,
        }
      }))
      for (const object of verified) {
        if (object) objects.push(object)
        if (objects.length >= limit) break
      }
    }

    return NextResponse.json({ bucketName: r2.bucketName, objects })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list recent objects"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
