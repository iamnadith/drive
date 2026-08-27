import { NextResponse } from "next/server"

import { getAllAccounts } from "@/lib/accounts-store"
import { listBucketDeliverySettings, type BucketDeliverySettings } from "@/lib/bucket-delivery-settings-store"
import { ensureBucketStatsRows, getBucketStatsMap } from "@/lib/bucket-stats-store"
import { r2ListBuckets } from "@/lib/cloudflare-r2-buckets"
import { readBucketSettings } from "@/lib/r2-bucket-settings"
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
    if (!account?.cloudflareAccountId || !account.apiToken) {
      return NextResponse.json({ error: "The active Cloudflare account is not configured", buckets: [] }, { status: 409 })
    }

    const listed = await r2ListBuckets({ accountId: account.cloudflareAccountId, apiToken: account.apiToken })
    const names = listed.map((bucket) => bucket.name)
    const [deliverySettings, assignedProjects] = await Promise.all([
      listBucketDeliverySettings(account.id, names),
      listAssignedProjectsForBuckets(names),
    ])
    const projectSettings = await listProjectDeliverySettings(
      Array.from(assignedProjects.values(), (project) => project.id)
    )
    let stats = new Map<string, { objects: number; bytes: number; status: string; error?: string }>()
    try {
      await ensureBucketStatsRows(account.id, names)
      stats = await getBucketStatsMap(account.id)
    } catch {
      // Bucket management remains available when cached usage stats are unavailable.
    }

    const buckets = (await Promise.all(
      listed.map(async (bucket) => {
        const cached = stats.get(bucket.name)
        const base = {
          id: `${account.id}:${bucket.name}`,
          accountId: account.id,
          accountLabel: account.label,
          accountStatus: account.status,
          name: bucket.name,
          createdAt: bucket.creation_date ?? null,
          jurisdiction: bucket.jurisdiction ?? "default",
          storageClass: bucket.storage_class ?? "Standard",
          objects: cached?.objects ?? bucket.objects ?? 0,
          bytes: cached?.bytes ?? bucket.size ?? 0,
          statsStatus: cached?.status ?? "pending",
        }
        try {
          return {
            ...base,
            settings: await readBucketSettings(account, bucket.name),
            deliverySettings: serializeDeliverySettings(
              deliverySettings.get(bucket.name)!,
              assignedProjects.get(bucket.name) ?? null,
              projectSettings.get(assignedProjects.get(bucket.name)?.id ?? "") ?? null
            ),
            settingsError: null,
          }
        } catch (error: unknown) {
          return {
            ...base,
            settings: null,
            deliverySettings: serializeDeliverySettings(
              deliverySettings.get(bucket.name)!,
              assignedProjects.get(bucket.name) ?? null,
              projectSettings.get(assignedProjects.get(bucket.name)?.id ?? "") ?? null
            ),
            settingsError: errorMessage(error, "Unable to load bucket settings"),
          }
        }
      })
    )).sort((a, b) => a.name.localeCompare(b.name))

    return NextResponse.json({
      buckets,
      activeAccount: { id: account.id, label: account.label, status: account.status },
      summary: {
        totalBuckets: buckets.length,
        // Per-bucket rows are updated in bounded worker batches. Use the
        // account totals, which are published only after the full sync, so a
        // partially refreshed bucket list cannot report a false aggregate.
        totalObjects: account.totalObjects ?? 0,
        totalBytes: account.totalBytes ?? 0,
        publicBuckets: buckets.filter((bucket) => bucket.settings?.publicAccess.enabled).length,
        corsPolicies: buckets.filter((bucket) => (bucket.settings?.corsRules.length ?? 0) > 0).length,
      },
    })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to load buckets") }, { status: 500 })
  }
}
