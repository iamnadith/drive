import { NextResponse } from "next/server"
import {
  authorizeProjectRequest,
  getActiveProjectR2Config,
} from "@/lib/project-api-auth"
import {
  recordProjectApiEvent,
  upsertProjectObjectInventory,
} from "@/lib/project-operations-store"
import { r2PutObject } from "@/lib/r2-s3"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    projectId?: unknown
    key?: unknown
  }
  const projectId =
    (typeof body.projectId === "string" ? body.projectId.trim() : "") ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  const rawKey = typeof body.key === "string" ? body.key.trim().replace(/^\/+/, "") : ""
  const key = rawKey ? (rawKey.endsWith("/") ? rawKey : `${rawKey}/`) : ""
  if (!key) return NextResponse.json({ error: "Folder key is required" }, { status: 400 })

  const authorized = await authorizeProjectRequest(request, projectId, "createFolder")
  if ("response" in authorized) return authorized.response
  const r2 = await getActiveProjectR2Config(authorized.auth.project)
  if ("response" in r2) return r2.response

  await r2PutObject(r2.config, authorized.auth.project.bucketName, key, "")
  await upsertProjectObjectInventory({
    projectId: authorized.auth.project.id,
    key,
    size: 0,
    contentType: "application/x-directory",
  }).catch(() => undefined)
  await recordProjectApiEvent({
    project: authorized.auth.project,
    apiKeyId: authorized.auth.apiKey.id,
    action: "folder.create",
    objectKey: key,
    request,
  })
  return NextResponse.json({ ok: true, projectId, key })
}
