import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectBucketR2Config,
  projectBucketFromRequest,
} from "@/lib/project-api-auth"
import { r2CreateSignedMultipartPartUrl } from "@/lib/r2-s3"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    key?: unknown
    uploadId?: unknown
    partNumber?: unknown
    expiresInSeconds?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const bucketName =
    (typeof (body as { bucket?: unknown }).bucket === "string"
      ? String((body as { bucket?: unknown }).bucket).trim()
      : "") || projectBucketFromRequest(request)
  const key = typeof body.key === "string" ? body.key.trim() : ""
  const uploadId = typeof body.uploadId === "string" ? body.uploadId.trim() : ""
  const partNumber = Number(body.partNumber)
  if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    return NextResponse.json(
      { error: "key, uploadId and partNumber are required" },
      { status: 400 }
    )
  }

  const authorized = await authorizeProjectRequest(request, projectId, "upload")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectBucketR2Config(authorized.auth.project, bucketName)
  if ("response" in r2) return r2.response

  const expiresInSeconds = Number(body.expiresInSeconds ?? 900)
  const url = await r2CreateSignedMultipartPartUrl(
    r2.config,
    r2.bucketName,
    key,
    uploadId,
    partNumber,
    expiresInSeconds
  )
  return NextResponse.json({ method: "PUT", url, key, uploadId, partNumber })
}
