import { NextResponse } from "next/server"
import { getActiveAccount } from "@/lib/accounts-store"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import {
  createProjectRecord,
  generateProjectId,
  listProjects,
  sanitizeBucketName,
} from "@/lib/projects-store"
import { r2CreateBucket } from "@/lib/r2-s3"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const projects = await listProjects()
    return NextResponse.json({ projects })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to load projects") },
      { status: 400 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const body = (await request.json().catch(() => ({}))) as { name?: unknown }
    const name = typeof body.name === "string" ? body.name.trim() : ""
    if (!name) {
      return NextResponse.json({ error: "Project name is required" }, { status: 400 })
    }

    const active = await getActiveAccount()
    if (
      !active?.cloudflareAccountId ||
      !active.r2AccessKeyId ||
      !active.r2SecretAccessKey
    ) {
      return NextResponse.json(
        { error: "Active Cloudflare account is missing R2 credentials" },
        { status: 400 }
      )
    }

    const projectId = generateProjectId()
    const bucketName = sanitizeBucketName(name, projectId)
    await r2CreateBucket(
      {
        accountId: active.cloudflareAccountId,
        accessKeyId: active.r2AccessKeyId,
        secretAccessKey: active.r2SecretAccessKey,
      },
      bucketName
    )

    const project = await createProjectRecord({
      name,
      projectId,
      bucketName,
      createdAccountId: active.id,
      createdAccountLabel: active.label,
    })

    await recordActivity({
      actorUserId: auth.user.id,
      action: "project.created",
      entityType: "project",
      entityId: project.projectId,
      entityLabel: project.name,
      summary: `Created project ${project.name}`,
      detail: `Created R2 bucket ${project.bucketName} from the active account.`,
      after: { project },
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ project })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to create project") },
      { status: 400 }
    )
  }
}
