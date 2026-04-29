import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectR2Config,
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
  const r2 = await getActiveProjectR2Config(authorized.auth.project)
  if ("response" in r2) return r2.response

  const expiresInSeconds = Number(body.expiresInSeconds ?? 900)
  const url = await r2CreateSignedMultipartPartUrl(
    r2.config,
    authorized.auth.project.bucketName,
    key,
    uploadId,
    partNumber,
    expiresInSeconds
  )
  return NextResponse.json({ method: "PUT", url, key, uploadId, partNumber })
}
