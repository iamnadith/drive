import { NextResponse } from "next/server"

import { getActiveAccount } from "@/lib/accounts-store"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import { r2CreateBucketViaApi, r2ListBuckets } from "@/lib/cloudflare-r2-buckets"
import { resolveProjectBucketCandidate } from "@/lib/project-bucket-name"
import {
  assignProjectBucket,
  getProjectByIdentifier,
  listProjectBuckets,
  removeProjectBucket,
  setProjectPrimaryBucket,
} from "@/lib/projects-store"
import { r2CreateBucket } from "@/lib/r2-s3"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? fallback)
      : fallback
  if (message.includes("drive_project_bucket_assignments_bucket_key")) {
    return "That bucket is already assigned to another project"
  }
  if (message.includes("drive_projects_bucket_name_key")) {
    return "That bucket is already assigned to another project"
  }
  return message
}

async function listActiveBuckets() {
  const active = await getActiveAccount()
  if (
    !active?.cloudflareAccountId ||
    !active.apiToken ||
    !active.r2AccessKeyId ||
    !active.r2SecretAccessKey
  ) {
    throw new Error("Active Cloudflare account is missing R2 credentials")
  }

  const buckets = await r2ListBuckets({
    accountId: active.cloudflareAccountId,
    apiToken: active.apiToken,
  })

  return { active, buckets }
}

async function ensureBucketExists(bucketName: string) {
  const { buckets } = await listActiveBuckets()
  if (!buckets.some((bucket) => bucket.name === bucketName)) {
    throw new Error("Bucket name does not exist in the active account")
  }
}

async function ensureBucketMissing(bucketName: string) {
  const { buckets } = await listActiveBuckets()
  if (buckets.some((bucket) => bucket.name === bucketName)) {
    throw new Error("Bucket name already exists")
  }
}

async function createBucket(bucketName: string) {
  const { active } = await listActiveBuckets()
  try {
    await r2CreateBucketViaApi({
      accountId: active.cloudflareAccountId!,
      apiToken: active.apiToken!,
      name: bucketName,
    })
    return
  } catch (apiError) {
    await r2CreateBucket(
      {
        accountId: active.cloudflareAccountId!,
        accessKeyId: active.r2AccessKeyId!,
        secretAccessKey: active.r2SecretAccessKey!,
      },
      bucketName
    ).catch(() => {
      throw apiError
    })
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const buckets = await listProjectBuckets(id)
    return NextResponse.json({ buckets })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to load project buckets") },
      { status: 400 }
    )
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const project = await getProjectByIdentifier(id)
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown
      bucketName?: unknown
      makePrimary?: unknown
    }
    const action = body.action === "link" ? "link" : "create"
    const rawBucketName = typeof body.bucketName === "string" ? body.bucketName.trim() : ""
    const bucketName = resolveProjectBucketCandidate({
      rawBucketName,
      fallbackProjectName: project.name,
    })
    if (!bucketName) {
      return NextResponse.json({ error: "Bucket name is required" }, { status: 400 })
    }

    if (action === "create") {
      await ensureBucketMissing(bucketName)
      await createBucket(bucketName)
    } else {
      await ensureBucketExists(bucketName)
    }

    const buckets = await assignProjectBucket({
      projectIdentifier: project.id,
      bucketName,
      makePrimary: body.makePrimary === true,
    })

    await recordActivity({
      actorUserId: auth.user.id,
      action: action === "create" ? "project.bucket.created" : "project.bucket.linked",
      entityType: "project",
      entityId: project.projectId,
      entityLabel: project.name,
      summary:
        action === "create"
          ? `Created bucket ${bucketName} for ${project.name}`
          : `Linked bucket ${bucketName} to ${project.name}`,
      metadata: { bucketName, makePrimary: body.makePrimary === true },
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ buckets })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to assign project bucket") },
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
    const project = await getProjectByIdentifier(id)
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

    const body = (await request.json().catch(() => ({}))) as { bucketName?: unknown }
    const bucketName =
      typeof body.bucketName === "string"
        ? resolveProjectBucketCandidate({
            rawBucketName: body.bucketName,
            fallbackProjectName: "",
          })
        : ""
    if (!bucketName) {
      return NextResponse.json({ error: "Bucket name is required" }, { status: 400 })
    }

    const buckets = await setProjectPrimaryBucket(project.id, bucketName)

    await recordActivity({
      actorUserId: auth.user.id,
      action: "project.bucket.primary_changed",
      entityType: "project",
      entityId: project.projectId,
      entityLabel: project.name,
      summary: `Set ${bucketName} as the primary bucket for ${project.name}`,
      metadata: { bucketName },
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ buckets })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to update primary bucket") },
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
    const project = await getProjectByIdentifier(id)
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })

    const body = (await request.json().catch(() => ({}))) as { bucketName?: unknown }
    const bucketName =
      typeof body.bucketName === "string"
        ? resolveProjectBucketCandidate({
            rawBucketName: body.bucketName,
            fallbackProjectName: "",
          })
        : ""
    if (!bucketName) {
      return NextResponse.json({ error: "Bucket name is required" }, { status: 400 })
    }

    const buckets = await removeProjectBucket(project.id, bucketName)

    await recordActivity({
      actorUserId: auth.user.id,
      action: "project.bucket.unlinked",
      entityType: "project",
      entityId: project.projectId,
      entityLabel: project.name,
      summary: `Removed bucket ${bucketName} from ${project.name}`,
      metadata: { bucketName },
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ buckets })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to remove project bucket") },
      { status: 400 }
    )
  }
}
