import { NextResponse } from "next/server"

import { getAllAccounts } from "@/lib/accounts-store"
import {
  getBucketDeliverySettings,
} from "@/lib/bucket-delivery-settings-store"
import {
  getEffectiveBucketMediaOrigins,
  updateAndSyncBucketDeliverySettings,
} from "@/lib/bucket-delivery-settings-service"
import {
  deleteBucketCors,
  putBucketCors,
  readBucketSettings,
  setManagedPublicDomain,
} from "@/lib/r2-bucket-settings"
import { requireAdmin } from "@/lib/server-auth"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import { getProjectByIdentifier } from "@/lib/projects-store"

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

async function serializeDeliverySettings(settings: Awaited<ReturnType<typeof getBucketDeliverySettings>>) {
  const effective = await getEffectiveBucketMediaOrigins(settings.bucketName, settings)
  const project = effective.projectId
    ? await getProjectByIdentifier(effective.projectId)
    : null
  return {
    accountId: settings.accountId,
    bucketName: settings.bucketName,
    deliveryPublicAccessEnabled: settings.publicAccessEnabled,
    manualMediaAllowedOrigins: settings.mediaAllowedOrigins,
    inheritedMediaAllowedOrigins: effective.inheritedMediaAllowedOrigins,
    effectiveMediaAllowedOrigins: effective.effectiveMediaAllowedOrigins,
    inheritedProject: project
      ? { id: project.id, projectId: project.projectId, name: project.name }
      : null,
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt,
  }
}

async function getContext(context: { params: Promise<{ accountId: string; bucket: string }> }) {
  const params = await context.params
  const accounts = await getAllAccounts()
  const account = accounts.find((candidate) => candidate.id === params.accountId)
  return { account, bucket: decodeURIComponent(params.bucket) }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ accountId: string; bucket: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response
    const { account, bucket } = await getContext(context)
    if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 })
    const [settings, deliverySettings] = await Promise.all([
      readBucketSettings(account, bucket),
      getBucketDeliverySettings(account.id, bucket),
    ])
    return NextResponse.json({ settings, deliverySettings: await serializeDeliverySettings(deliverySettings) })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to load bucket settings") }, { status: 400 })
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ accountId: string; bucket: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response
    const { account, bucket } = await getContext(context)
    if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 })
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const [before, beforeDeliverySettings] = await Promise.all([
      readBucketSettings(account, bucket),
      getBucketDeliverySettings(account.id, bucket),
    ])
    if (typeof body.publicAccessEnabled === "boolean") {
      await setManagedPublicDomain(account, bucket, body.publicAccessEnabled)
    }
    if ("corsRules" in body) await putBucketCors(account, bucket, body.corsRules)
    const hasDeliverySettingsChange =
      typeof body.deliveryPublicAccessEnabled === "boolean" || "manualMediaAllowedOrigins" in body
    if (hasDeliverySettingsChange) {
      await updateAndSyncBucketDeliverySettings({
        account,
        bucketName: bucket,
        ...(typeof body.deliveryPublicAccessEnabled === "boolean"
          ? { publicAccessEnabled: body.deliveryPublicAccessEnabled }
          : {}),
        ...("manualMediaAllowedOrigins" in body ? { mediaAllowedOrigins: body.manualMediaAllowedOrigins } : {}),
      })
    }
    if (
      !("corsRules" in body) &&
      typeof body.publicAccessEnabled !== "boolean" &&
      !hasDeliverySettingsChange
    ) {
      return NextResponse.json({ error: "No settings change was provided" }, { status: 400 })
    }
    const [settings, deliverySettings] = await Promise.all([
      readBucketSettings(account, bucket),
      getBucketDeliverySettings(account.id, bucket),
    ])
    await recordActivity({
      actorUserId: auth.user.id,
      action: "bucket.settings_updated",
      entityType: "bucket",
      entityId: `${account.id}:${bucket}`,
      entityLabel: bucket,
      summary: `Updated settings for ${bucket}`,
      detail: "Changed Cloudflare bucket settings or Drive delivery authorization.",
      before: { settings: before, deliverySettings: beforeDeliverySettings },
      after: { settings, deliverySettings },
      undoable: false,
      undoReason: "Cloudflare bucket settings changes are applied immediately.",
      ...getRequestActivityContext(request),
    })
    return NextResponse.json({ settings, deliverySettings: await serializeDeliverySettings(deliverySettings) })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to update bucket settings") }, { status: 400 })
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ accountId: string; bucket: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response
    const { account, bucket } = await getContext(context)
    if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 })
    const target = new URL(request.url).searchParams.get("target")
    if (target !== "cors") return NextResponse.json({ error: "Unsupported settings target" }, { status: 400 })
    const before = await readBucketSettings(account, bucket)
    await deleteBucketCors(account, bucket)
    const settings = await readBucketSettings(account, bucket)
    await recordActivity({
      actorUserId: auth.user.id,
      action: "bucket.cors_removed",
      entityType: "bucket",
      entityId: `${account.id}:${bucket}`,
      entityLabel: bucket,
      summary: `Removed CORS rules from ${bucket}`,
      detail: "Removed the bucket CORS configuration.",
      before,
      after: settings,
      undoable: false,
      undoReason: "Cloudflare bucket settings changes are applied immediately.",
      ...getRequestActivityContext(request),
    })
    return NextResponse.json({ settings })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to remove bucket CORS rules") }, { status: 400 })
  }
}
