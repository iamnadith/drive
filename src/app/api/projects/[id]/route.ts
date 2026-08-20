import { NextResponse } from "next/server"
import { getActiveAccount } from "@/lib/accounts-store"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import { getProjectDeliverySettings, updateProjectDeliverySettings } from "@/lib/project-delivery-settings-store"
import { syncProjectDeliveryCors } from "@/lib/bucket-delivery-settings-service"
import {
  deleteProjectRecord,
  getProjectByIdentifier,
  listProjectBuckets,
  updateProjectRecord,
} from "@/lib/projects-store"
import { r2DeleteBucketAndContents } from "@/lib/r2-s3"
import { getBucketDeliverySettings } from "@/lib/bucket-delivery-settings-store"
import { syncBucketDeliveryCorsRule } from "@/lib/r2-bucket-settings"
import { allowedStorageCorsOrigins } from "@/lib/storage-delivery.cjs"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? fallback)
      : fallback
  return message
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
    const deliverySettings = await getProjectDeliverySettings(project.id)
    return NextResponse.json({ project, deliverySettings })
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
      mediaAllowedOrigins?: unknown
    }
    const status =
      body.status === "active" || body.status === "disabled" ? body.status : undefined
    const name = typeof body.name === "string" ? body.name : undefined
    const before = await getProjectByIdentifier(id)
    if (!before) return NextResponse.json({ error: "Project not found" }, { status: 404 })

    const hasDeliveryPolicyUpdate = Object.prototype.hasOwnProperty.call(body, "mediaAllowedOrigins")
    if (hasDeliveryPolicyUpdate) {
      const assignedBuckets = await listProjectBuckets(before.id)
      const active = assignedBuckets.length > 0 ? await getActiveAccount() : null
      if (assignedBuckets.length > 0 && !active) {
        return NextResponse.json({ error: "No active Cloudflare account is configured" }, { status: 409 })
      }
      const beforeDelivery = await getProjectDeliverySettings(before.id)
      const project = await updateProjectRecord(id, { name, status })
      let deliverySettings
      try {
        deliverySettings = await updateProjectDeliverySettings({
          projectId: project.id,
          mediaAllowedOrigins: body.mediaAllowedOrigins,
        })
        if (active) {
          await syncProjectDeliveryCors({ account: active, projectIdentifier: project.id })
        }
      } catch (error) {
        await updateProjectDeliverySettings({
          projectId: before.id,
          mediaAllowedOrigins: beforeDelivery.mediaAllowedOrigins,
        }).catch(() => undefined)
        if (active) {
          await syncProjectDeliveryCors({ account: active, projectIdentifier: before.id }).catch(() => undefined)
        }
        await updateProjectRecord(before.id, {
          name: before.name,
          status: before.status,
        }).catch(() => undefined)
        throw error
      }

      await recordActivity({
        actorUserId: auth.user.id,
        action: "project.delivery_policy_updated",
        entityType: "project",
        entityId: project.projectId,
        entityLabel: project.name,
        summary: `Updated media delivery origins for ${project.name}`,
        before: { project: before, deliverySettings: beforeDelivery },
        after: { project, deliverySettings },
        ...getRequestActivityContext(request),
      })

      return NextResponse.json({ project, deliverySettings })
    }

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
    const assignedBuckets = await listProjectBuckets(project.id)

    const active = assignedBuckets.length > 0 ? await getActiveAccount() : null
    if (deleteBucket) {
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
      for (const bucket of assignedBuckets) {
        await r2DeleteBucketAndContents(
          {
            accountId: active.cloudflareAccountId,
            accessKeyId: active.r2AccessKeyId,
            secretAccessKey: active.r2SecretAccessKey,
          },
          bucket.bucketName
        )
      }
    } else if (assignedBuckets.length > 0) {
      if (!active) {
        return NextResponse.json(
          { error: "No active Cloudflare account is configured" },
          { status: 409 }
        )
      }
      try {
        for (const bucket of assignedBuckets) {
          const settings = await getBucketDeliverySettings(active.id, bucket.bucketName)
          await syncBucketDeliveryCorsRule(
            active,
            bucket.bucketName,
            (settings.mediaAllowedOrigins ?? allowedStorageCorsOrigins())
              .filter((origin): origin is string => typeof origin === "string")
          )
        }
      } catch (error) {
        await syncProjectDeliveryCors({
          account: active,
          projectIdentifier: project.id,
        }).catch(() => undefined)
        throw error
      }
    }

    try {
      await deleteProjectRecord(project.id)
    } catch (error) {
      if (!deleteBucket && active) {
        await syncProjectDeliveryCors({
          account: active,
          projectIdentifier: project.id,
        }).catch(() => undefined)
      }
      throw error
    }

    await recordActivity({
      actorUserId: auth.user.id,
      action: deleteBucket ? "project.deleted_with_bucket" : "project.deleted",
      entityType: "project",
      entityId: project.projectId,
      entityLabel: project.name,
      summary: deleteBucket
        ? `Deleted project ${project.name} and its buckets`
        : `Deleted project ${project.name}`,
      detail: deleteBucket
        ? `Deleted ${assignedBuckets.length} assigned R2 bucket(s) from the active account.`
        : `Kept ${assignedBuckets.length} assigned R2 bucket(s).`,
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
