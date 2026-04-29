import { NextResponse } from "next/server"
import { getActiveAccount } from "@/lib/accounts-store"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import {
  deleteProjectRecord,
  getProjectByIdentifier,
  updateProjectRecord,
} from "@/lib/projects-store"
import { r2DeleteBucketAndContents } from "@/lib/r2-s3"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const project = await getProjectByIdentifier(id)
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
    return NextResponse.json({ project })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to load project") },
      { status: 400 }
    )
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown
      status?: unknown
    }
    const status =
      body.status === "active" || body.status === "disabled" ? body.status : undefined
    const name = typeof body.name === "string" ? body.name : undefined
    const before = await getProjectByIdentifier(id)
    const project = await updateProjectRecord(id, { name, status })

    await recordActivity({
      actorUserId: auth.user.id,
      action: "project.updated",
      entityType: "project",
      entityId: project.projectId,
      entityLabel: project.name,
      summary: `Updated project ${project.name}`,
      before: before ? { project: before } : null,
      after: { project },
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ project })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to update project") },
      { status: 400 }
    )
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as { deleteBucket?: unknown }
    const deleteBucket = body.deleteBucket === true
    const project = await getProjectByIdentifier(id)
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

    if (deleteBucket) {
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
      await r2DeleteBucketAndContents(
        {
          accountId: active.cloudflareAccountId,
          accessKeyId: active.r2AccessKeyId,
          secretAccessKey: active.r2SecretAccessKey,
        },
        project.bucketName
      )
    }

    await deleteProjectRecord(project.id)

    await recordActivity({
      actorUserId: auth.user.id,
      action: deleteBucket ? "project.deleted_with_bucket" : "project.deleted",
      entityType: "project",
      entityId: project.projectId,
      entityLabel: project.name,
      summary: deleteBucket
        ? `Deleted project ${project.name} and its bucket`
        : `Deleted project ${project.name}`,
      detail: deleteBucket
        ? `Deleted R2 bucket ${project.bucketName} from the active account.`
        : `Kept R2 bucket ${project.bucketName}.`,
      before: { project },
      undoReason: "Projects and generated API key secrets cannot be restored automatically.",
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to delete project") },
      { status: 400 }
    )
  }
}
