import { NextResponse } from "next/server"
import { queryDb } from "@/lib/db"
import {
  authorizeProjectRequest,
  projectBucketFromRequest,
  resolveProjectBucketName,
} from "@/lib/project-api-auth"
import {
  ensureProjectOperationsSchema,
  recordProjectApiEvent,
} from "@/lib/project-operations-store"
import { hashProjectSecret } from "@/lib/projects-store"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    bucket?: unknown
    key?: unknown
    lockToken?: unknown
    reason?: unknown
    expiresAt?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const bucketName =
    (typeof body.bucket === "string" ? body.bucket.trim() : "") || projectBucketFromRequest(request)
  const key = typeof body.key === "string" ? body.key.trim() : ""
  const lockToken = typeof body.lockToken === "string" ? body.lockToken.trim() : ""
  if (!key || !lockToken) {
    return NextResponse.json({ error: "key and lockToken are required" }, { status: 400 })
  }
  const authorized = await authorizeProjectRequest(request, projectId, "write")
  if ("response" in authorized) return authorized.response
  await ensureProjectOperationsSchema()
  const resolvedBucket = await resolveProjectBucketName(authorized.auth.project, bucketName)
  if ("response" in resolvedBucket) return resolvedBucket.response
  await queryDb(
    `
      insert into drive_project_object_locks
        (project_id, bucket_name, object_key, lock_token_hash, reason, expires_at)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (project_id, bucket_name, object_key) do update set
        lock_token_hash = excluded.lock_token_hash,
        reason = excluded.reason,
        expires_at = excluded.expires_at,
        created_at = now();
    `,
    [
      authorized.auth.project.id,
      resolvedBucket.bucketName,
      key,
      hashProjectSecret(lockToken),
      typeof body.reason === "string" ? body.reason : null,
      typeof body.expiresAt === "string" ? body.expiresAt : null,
    ]
  )
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.lock",
    objectKey: key,
    request,
    metadata: { bucketName: resolvedBucket.bucketName },
  })
  return NextResponse.json({ ok: true, projectId, bucketName: resolvedBucket.bucketName, key })
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    bucket?: unknown
    key?: unknown
    lockToken?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const bucketName =
    (typeof body.bucket === "string" ? body.bucket.trim() : "") || projectBucketFromRequest(request)
  const key = typeof body.key === "string" ? body.key.trim() : ""
  const lockToken = typeof body.lockToken === "string" ? body.lockToken.trim() : ""
  if (!key || !lockToken) {
    return NextResponse.json({ error: "key and lockToken are required" }, { status: 400 })
  }
  const authorized = await authorizeProjectRequest(request, projectId, "write")
  if ("response" in authorized) return authorized.response
  await ensureProjectOperationsSchema()
  const resolvedBucket = await resolveProjectBucketName(authorized.auth.project, bucketName)
  if ("response" in resolvedBucket) return resolvedBucket.response
  const result = await queryDb(
    `
      delete from drive_project_object_locks
      where project_id = $1 and bucket_name = $2 and object_key = $3 and lock_token_hash = $4;
    `,
    [authorized.auth.project.id, resolvedBucket.bucketName, key, hashProjectSecret(lockToken)]
  )
  if ((result.rowCount ?? 0) === 0) {
    return NextResponse.json({ error: "Lock not found or token mismatch" }, { status: 409 })
  }
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "file.unlock",
    objectKey: key,
    request,
    metadata: { bucketName: resolvedBucket.bucketName },
  })
  return NextResponse.json({ ok: true, projectId, bucketName: resolvedBucket.bucketName, key })
}
