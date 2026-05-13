import { NextResponse } from "next/server"
import { getActiveProjectBucketR2Config } from "@/lib/project-api-auth"
import { getProjectByIdentifier } from "@/lib/projects-store"
import { r2CreateSignedUploadUrl } from "@/lib/r2-s3"

export async function GET(
  request: Request,
  context: { params: Promise<{ key: string }> }
) {
  const { key: rawKey } = await context.params
  const url = new URL(request.url)
  const projectId = url.searchParams.get("projectId")?.trim() || request.headers.get("x-drive-project")?.trim() || ""
  const bucketName = url.searchParams.get("bucket")?.trim() || request.headers.get("x-drive-bucket")?.trim() || ""
  const key = rawKey ? decodeURIComponent(rawKey).trim().replace(/^\/+/, "") : ""
  if (!projectId) return NextResponse.json({ error: "Project ID is required" }, { status: 400 })
  if (!key || key.endsWith("/")) {
    return NextResponse.json({ error: "Valid object key is required" }, { status: 400 })
  }

  const apiKey = request.headers.get("authorization") ?? request.headers.get("x-drive-api-key") ?? ""
  const normalizedRequest = new Request(request.url, {
    method: request.method,
    headers: new Headers({
      authorization: apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey.replace(/^Bearer\s+/i, "")}`,
      "x-drive-project": projectId,
      ...(bucketName ? { "x-drive-bucket": bucketName } : {}),
    }),
  })

  const project = await getProjectByIdentifier(projectId)
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
  const r2 = await getActiveProjectBucketR2Config(project, bucketName)
  if ("response" in r2) return r2.response

  const expiresInSeconds = Math.max(30, Math.min(14_400, Number(url.searchParams.get("expiresInSeconds") ?? 14_400)))
  const contentType = url.searchParams.get("contentType")?.trim() || undefined

  // Reuse request auth through the project upload route expectations without rewriting media-panel upload flow.
  const { authorizeProjectRequest } = await import("@/lib/project-api-auth")
  const authorized = await authorizeProjectRequest(normalizedRequest, projectId, "upload")
  if ("response" in authorized) return authorized.response

  const signedUrl = await r2CreateSignedUploadUrl(r2.config, r2.bucketName, key, {
    expiresInSeconds,
    contentType,
  })
  return NextResponse.json({
    url: signedUrl,
    key,
    bucketName: r2.bucketName,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  })
}
