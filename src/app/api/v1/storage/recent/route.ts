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
        const head = await r2HeadObject(r2.config, r2.bucketName, key).catch(() => null)
        if (!head) return null
        return {
          key,
          url: buildProjectStorageObjectUrl(request, r2.bucketName, key),
          fileName: key,
          size: typeof head.ContentLength === "number" ? head.ContentLength : 0,
          uploadedAt: head.LastModified?.toISOString() ?? row.occurred_at ?? null,
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
