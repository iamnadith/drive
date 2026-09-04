import { NextResponse } from "next/server"

import { getAllAccounts } from "@/lib/accounts-store"
import { listBucketDeliverySettings, type BucketDeliverySettings } from "@/lib/bucket-delivery-settings-store"
import { listBucketSettingsSnapshots } from "@/lib/bucket-settings-snapshot-store"
import { getBucketStatsMap, type DriveBucketStats } from "@/lib/bucket-stats-store"
import { requireAdmin } from "@/lib/server-auth"
import { mergeMediaAllowedOrigins } from "@/lib/project-media-origins.cjs"
import { listAssignedProjectsForBuckets, type Project } from "@/lib/projects-store"
import { listProjectDeliverySettings, type ProjectDeliverySettings } from "@/lib/project-delivery-settings-store"
import { allowedStorageCorsOrigins } from "@/lib/storage-delivery.cjs"

function serializeDeliverySettings(
  settings: BucketDeliverySettings,
  project: Project | null,
  projectSettings: ProjectDeliverySettings | null
) {
  const inherited = projectSettings?.mediaAllowedOrigins ?? null
  const manual = settings.mediaAllowedOrigins
  const effective = inherited === null && manual === null
    ? allowedStorageCorsOrigins().filter((origin): origin is string => typeof origin === "string")
    : mergeMediaAllowedOrigins(inherited, manual)
  return {
    accountId: settings.accountId,
    bucketName: settings.bucketName,
    deliveryPublicAccessEnabled: settings.publicAccessEnabled,
    manualMediaAllowedOrigins: settings.mediaAllowedOrigins,
    inheritedMediaAllowedOrigins: inherited,
    effectiveMediaAllowedOrigins: effective,
    inheritedProject: project
      ? { id: project.id, projectId: project.projectId, name: project.name }
      : null,
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

    const accounts = await getAllAccounts()
    const account = accounts.find((candidate) => candidate.status === "active")
    if (!account) {
      return NextResponse.json({ error: "There is no active Cloudflare account", buckets: [] }, { status: 409 })
    }

    const [snapshots, stats] = await Promise.all([
      listBucketSettingsSnapshots(account.id),
      getBucketStatsMap(account.id).catch(() => new Map<string, DriveBucketStats>()),
    ])
    const snapshotByName = new Map(snapshots.map((snapshot) => [snapshot.bucketName, snapshot]))
    const names = Array.from(new Set([...snapshots.map((snapshot) => snapshot.bucketName), ...stats.keys()]))
    const [deliverySettings, assignedProjects] = await Promise.all([
      listBucketDeliverySettings(account.id, names),
      listAssignedProjectsForBuckets(names),
    ])
    const projectSettings = await listProjectDeliverySettings(
      Array.from(assignedProjects.values(), (project) => project.id)
    )
    const buckets = names.map((name) => {
      const snapshot = snapshotByName.get(name)
      const cached = stats.get(name)
      return {
        id: `${account.id}:${name}`,
        accountId: account.id,
        accountLabel: account.label,
        accountStatus: account.status,
        name,
        createdAt: snapshot?.createdAt ?? null,
        jurisdiction: snapshot?.jurisdiction ?? "default",
        storageClass: snapshot?.storageClass ?? "Standard",
        objects: cached?.objects ?? 0,
        bytes: cached?.bytes ?? 0,
        statsStatus: cached?.status ?? "pending",
        settings: snapshot?.settings ?? null,
        deliverySettings: serializeDeliverySettings(
          deliverySettings.get(name)!,
          assignedProjects.get(name) ?? null,
          projectSettings.get(assignedProjects.get(name)?.id ?? "") ?? null
        ),
        settingsStatus: snapshot?.settingsStatus ?? "pending",
        settingsError: snapshot?.settingsError ?? null,
        settingsLastAttemptedAt: snapshot?.settingsLastAttemptedAt ?? null,
        settingsLastSyncedAt: snapshot?.settingsLastSyncedAt ?? null,
        inventorySyncedAt: snapshot?.inventorySyncedAt ?? null,
      }
    }).sort((a, b) => a.name.localeCompare(b.name))

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
