import { NextResponse } from "next/server"

import { getBucketDashboardBootstrap } from "@/lib/bucket-dashboard-store"
import { requireAdmin } from "@/lib/server-auth"
import { mergeManyMediaAllowedOrigins, resolveEffectiveMediaAllowedOrigins } from "@/lib/project-media-origins.cjs"
import { allowedStorageCorsOrigins } from "@/lib/storage-delivery.cjs"

function serializeDeliverySettings(
  accountId: string,
  bucketName: string,
  settings: { publicAccessEnabled: boolean; mediaAllowedOrigins: string[] | null; createdAt: string | null; updatedAt: string | null },
  projects: Array<{ id: string; projectId: string; name: string; mediaAllowedOrigins: string[] | null }>
) {
  const inheritedPolicies = projects
    .map((entry) => entry.mediaAllowedOrigins)
    .filter((origins): origins is string[] => Array.isArray(origins))
  const inherited = inheritedPolicies.length > 0
    ? mergeManyMediaAllowedOrigins(inheritedPolicies)
    : null
  const manual = settings.mediaAllowedOrigins
  const effective = resolveEffectiveMediaAllowedOrigins({
    inheritedPolicies,
    manual,
    fallback: allowedStorageCorsOrigins().filter((origin): origin is string => typeof origin === "string"),
  })
  return {
    accountId,
    bucketName,
    deliveryPublicAccessEnabled: settings.publicAccessEnabled,
    manualMediaAllowedOrigins: settings.mediaAllowedOrigins,
    inheritedMediaAllowedOrigins: inherited,
    effectiveMediaAllowedOrigins: effective,
    inheritedProject: projects[0]
      ? { id: projects[0].id, projectId: projects[0].projectId, name: projects[0].name }
      : null,
    inheritedProjects: projects.map((project) => ({ id: project.id, projectId: project.projectId, name: project.name })),
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt,
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const bootstrap = await getBucketDashboardBootstrap()
    if (!bootstrap) {
      return NextResponse.json({ error: "There is no active Cloudflare account", buckets: [] }, { status: 409 })
    }
    const { account } = bootstrap
    const buckets = bootstrap.buckets.map((bucket) => {
      const snapshot = bucket.snapshot
      return {
        id: `${account.id}:${bucket.name}`,
        accountId: account.id,
        accountLabel: account.label,
        accountStatus: account.status,
        name: bucket.name,
        createdAt: snapshot?.createdAt ?? null,
        jurisdiction: snapshot?.jurisdiction ?? "default",
        storageClass: snapshot?.storageClass ?? "Standard",
        objects: bucket.objects,
        bytes: bucket.bytes,
        statsStatus: bucket.statsStatus,
        statsError: bucket.statsError,
        statsUpdatedAt: bucket.statsUpdatedAt,
        settings: snapshot?.settings ?? null,
        deliverySettings: serializeDeliverySettings(account.id, bucket.name, {
          publicAccessEnabled: bucket.publicAccessEnabled,
          mediaAllowedOrigins: bucket.mediaAllowedOrigins,
          createdAt: bucket.deliveryCreatedAt,
          updatedAt: bucket.deliveryUpdatedAt,
        }, bucket.projects),
        settingsStatus: snapshot?.settingsStatus ?? "pending",
        settingsError: snapshot?.settingsError ?? null,
        settingsLastAttemptedAt: snapshot?.settingsLastAttemptedAt ?? null,
        settingsLastSyncedAt: snapshot?.settingsLastSyncedAt ?? null,
        inventorySyncedAt: snapshot?.inventorySyncedAt ?? null,
      }
    })

    return NextResponse.json({
      buckets,
      activeAccount: {
        id: account.id,
        label: account.label,
        status: account.status,
        lastSyncedAt: account.lastSyncedAt ?? null,
      },
      summary: {
        totalBuckets: buckets.length,
        // A successful worker cycle publishes account aggregates atomically
        // after all bucket rows finish. Preserve legitimate zero totals and do
        // not replace them with stale per-bucket values.
        totalObjects: account.syncStatus === "ok"
          ? account.totalObjects
          : buckets.reduce((sum, bucket) => sum + bucket.objects, 0),
        totalBytes: account.syncStatus === "ok"
          ? account.totalBytes
          : buckets.reduce((sum, bucket) => sum + bucket.bytes, 0),
        publicBuckets: buckets.filter((bucket) => bucket.settings?.publicAccess.enabled).length,
        corsPolicies: buckets.filter((bucket) => (bucket.settings?.corsRules.length ?? 0) > 0).length,
      },
    })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to load buckets") }, { status: 500 })
  }
}
