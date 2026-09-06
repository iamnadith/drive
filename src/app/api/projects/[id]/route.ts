import { NextResponse } from "next/server"
import { getActiveAccount } from "@/lib/accounts-store"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import { getProjectDeliverySettings, updateProjectDeliverySettings } from "@/lib/project-delivery-settings-store"
import {
  assertProjectDeliveryOriginsFitAssignedBuckets,
  deleteBucketDeliveryCorsReconciliation,
  getEffectiveBucketMediaOrigins,
  queueBucketDeliveryCorsReconciliation,
  syncProjectDeliveryCors,
} from "@/lib/bucket-delivery-settings-service"
import {
  deleteProjectRecord,
  getProjectByIdentifier,
  listProjectBuckets,
  listProjectsUsingBucket,
  updateProjectRecord,
} from "@/lib/projects-store"
import { r2DeleteBucketAndContents } from "@/lib/r2-s3"
import { deleteBucketDeliverySettings, getBucketDeliverySettings } from "@/lib/bucket-delivery-settings-store"
import { readBucketSettings, syncBucketDeliveryCorsRule } from "@/lib/r2-bucket-settings"
import { allowedStorageCorsOrigins } from "@/lib/storage-delivery.cjs"
import { resolveEffectiveMediaAllowedOrigins } from "@/lib/project-media-origins.cjs"
import { deleteBucketSettingsSnapshot, listBucketSettingsSnapshots, upsertBucketSettingsSnapshot } from "@/lib/bucket-settings-snapshot-store"
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
    const active = await getActiveAccount()
    const assignedBuckets = await listProjectBuckets(project.id)
    const scopedBuckets = active
      ? assignedBuckets.filter((bucket) => !bucket.accountId || bucket.accountId === active.id)
      : []
    const snapshots = active ? await listBucketSettingsSnapshots(active.id) : []
    const snapshotByBucket = new Map(snapshots.map((snapshot) => [snapshot.bucketName, snapshot]))
    const bucketDeliveryRules = active ? await Promise.all(scopedBuckets.map(async (bucket) => {
      const settings = await getBucketDeliverySettings(active.id, bucket.bucketName)
      const effective = await getEffectiveBucketMediaOrigins(active.id, bucket.bucketName, settings)
      const snapshot = snapshotByBucket.get(bucket.bucketName)
      const provider = await readBucketSettings(active, bucket.bucketName)
        .then(async (live) => {
          await upsertBucketSettingsSnapshot(active.id, bucket.bucketName, live)
          return { corsRules: live.corsRules, status: "live", lastSyncedAt: new Date().toISOString() }
        })
        .catch(() => ({
          corsRules: snapshot?.settings?.corsRules ?? [],
          status: snapshot?.settingsStatus ?? "unavailable",
          lastSyncedAt: snapshot?.settingsLastSyncedAt ?? null,
        }))
      return {
        bucketName: bucket.bucketName,
        projectCount: bucket.projectCount,
        manualMediaAllowedOrigins: settings.mediaAllowedOrigins,
        inheritedMediaAllowedOrigins: effective.inheritedMediaAllowedOrigins,
        effectiveMediaAllowedOrigins: effective.effectiveMediaAllowedOrigins,
        corsRules: provider.corsRules,
        providerStatus: provider.status,
        providerLastSyncedAt: provider.lastSyncedAt,
      }
    })) : []
    return NextResponse.json({ project, deliverySettings, bucketDeliveryRules })
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
      if (active && assignedBuckets.some((bucket) => bucket.accountId && bucket.accountId !== active.id)) {
        return NextResponse.json(
          { error: "Switch to the Cloudflare account that owns every assigned bucket before updating delivery policy" },
          { status: 409 }
        )
      }
      const beforeDelivery = await getProjectDeliverySettings(before.id)
      await assertProjectDeliveryOriginsFitAssignedBuckets({
        projectId: before.id,
        mediaAllowedOrigins: body.mediaAllowedOrigins,
      })
      const project = await updateProjectRecord(id, { name, status })
      if (active) {
        await Promise.all(
          assignedBuckets.map((bucket) => queueBucketDeliveryCorsReconciliation(active.id, bucket.bucketName))
        )
      }
      const deliverySettings = await updateProjectDeliverySettings({
        projectId: project.id,
        mediaAllowedOrigins: body.mediaAllowedOrigins,
      })
      let deliverySyncPending = false
      if (active) {
        try {
          await syncProjectDeliveryCors({ account: active, projectIdentifier: project.id })
        } catch {
          deliverySyncPending = true
        }
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

      return NextResponse.json({ project, deliverySettings, deliverySyncPending })
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

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as { action?: unknown }
    if (body.action !== "syncDelivery") {
      return NextResponse.json({ error: "Unsupported project action" }, { status: 400 })
    }
    const project = await getProjectByIdentifier(id)
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 })
    const buckets = await listProjectBuckets(project.id)
    if (buckets.length === 0) {
      return NextResponse.json({ ok: true, synchronizedBuckets: 0 })
    }
    const active = await getActiveAccount()
    if (!active) {
      return NextResponse.json({ error: "No active Cloudflare account is configured" }, { status: 409 })
    }
    await syncProjectDeliveryCors({ account: active, projectIdentifier: project.id })
    await recordActivity({
      actorUserId: auth.user.id,
      action: "project.delivery_policy_synchronized",
      entityType: "project",
      entityId: project.projectId,
      entityLabel: project.name,
      summary: `Synchronized delivery policy for ${project.name}`,
      detail: `Verified the managed CORS rule on ${buckets.length} assigned bucket(s).`,
      metadata: { bucketCount: buckets.length },
      ...getRequestActivityContext(request),
    })
    return NextResponse.json({ ok: true, synchronizedBuckets: buckets.length })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to synchronize project delivery policy") },
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
    if (assignedBuckets.length > 0 && !active) {
      return NextResponse.json({ error: "No active Cloudflare account is configured" }, { status: 409 })
    }
    const foreignAssignments = active
      ? assignedBuckets.filter((bucket) => bucket.accountId && bucket.accountId !== active.id)
      : []
    if (foreignAssignments.length > 0) {
      return NextResponse.json(
        { error: "Switch to the Cloudflare account that owns every assigned bucket before deleting this project" },
        { status: 409 }
      )
    }
    const bucketProjects = new Map(
      await Promise.all(
        assignedBuckets.map(async (bucket) => [
          bucket.bucketName,
          await listProjectsUsingBucket(active!.id, bucket.bucketName),
        ] as const)
      )
    )
    const sharedBuckets = assignedBuckets.filter((bucket) =>
      (bucketProjects.get(bucket.bucketName) ?? []).some((candidate) => candidate.id !== project.id)
    )
    const bucketsToDelete = deleteBucket
      ? assignedBuckets.filter((bucket) => !sharedBuckets.some((shared) => shared.bucketName === bucket.bucketName))
      : []
    const bucketsToKeep = deleteBucket ? sharedBuckets : assignedBuckets

    if (bucketsToDelete.length > 0) {
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
      for (const bucket of bucketsToDelete) {
        const currentProjects = await listProjectsUsingBucket(active.id, bucket.bucketName)
        if (currentProjects.some((candidate) => candidate.id !== project.id)) {
          return NextResponse.json(
            { error: `Bucket ${bucket.bucketName} became shared while deletion was being prepared; no further buckets were deleted` },
            { status: 409 }
          )
        }
        await r2DeleteBucketAndContents(
          {
            accountId: active.cloudflareAccountId,
            accessKeyId: active.r2AccessKeyId,
            secretAccessKey: active.r2SecretAccessKey,
          },
          bucket.bucketName
        )
        await deleteBucketDeliverySettings(active.id, bucket.bucketName)
        await deleteBucketSettingsSnapshot(active.id, bucket.bucketName)
        await deleteBucketDeliveryCorsReconciliation(active.id, bucket.bucketName)
      }
    }
    if (bucketsToKeep.length > 0) {
      if (!active) {
        return NextResponse.json(
          { error: "No active Cloudflare account is configured" },
          { status: 409 }
        )
      }
      try {
        for (const bucket of bucketsToKeep) {
          await queueBucketDeliveryCorsReconciliation(active.id, bucket.bucketName)
          const settings = await getBucketDeliverySettings(active.id, bucket.bucketName)
          const remainingProjects = (bucketProjects.get(bucket.bucketName) ?? []).filter(
            (candidate) => candidate.id !== project.id
          )
          const remainingPolicies = await Promise.all(
            remainingProjects.map((candidate) => getProjectDeliverySettings(candidate.id))
          )
          const explicitInherited = remainingPolicies
            .map((policy) => policy.mediaAllowedOrigins)
            .filter((origins): origins is string[] => Array.isArray(origins))
          const effective = resolveEffectiveMediaAllowedOrigins({
            inheritedPolicies: explicitInherited,
            manual: settings.mediaAllowedOrigins,
            fallback: allowedStorageCorsOrigins(),
          })
          await syncBucketDeliveryCorsRule(
            active,
            bucket.bucketName,
            effective.filter((origin): origin is string => typeof origin === "string")
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
      if (active && bucketsToKeep.length > 0) {
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
        ? `Deleted project ${project.name} and its unshared buckets`
        : `Deleted project ${project.name}`,
      detail: deleteBucket
        ? `Deleted ${bucketsToDelete.length} unshared R2 bucket(s) and kept ${sharedBuckets.length} bucket(s) used by other projects.`
        : `Kept ${assignedBuckets.length} assigned R2 bucket(s).`,
      before: { project },
      undoReason: "Projects and generated API key secrets cannot be restored automatically.",
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ ok: true, deletedBuckets: bucketsToDelete.length, keptSharedBuckets: sharedBuckets.length })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to delete project") },
      { status: 400 }
    )
  }
}
