import { NextResponse } from "next/server"

import { getAllAccounts } from "@/lib/accounts-store"
import { ensureBucketStatsRows, getBucketStatsMap } from "@/lib/bucket-stats-store"
import { r2ListBuckets } from "@/lib/cloudflare-r2-buckets"
import { readBucketSettings } from "@/lib/r2-bucket-settings"
import { requireAdmin } from "@/lib/server-auth"

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
          return { ...base, settings: await readBucketSettings(account, bucket.name), settingsError: null }
        } catch (error: unknown) {
          return { ...base, settings: null, settingsError: errorMessage(error, "Unable to load bucket settings") }
        }
      })
    )).sort((a, b) => a.name.localeCompare(b.name))

    return NextResponse.json({
      buckets,
      activeAccount: { id: account.id, label: account.label, status: account.status },
      summary: {
        totalBuckets: buckets.length,
        totalObjects: buckets.reduce((sum, bucket) => sum + bucket.objects, 0),
        totalBytes: buckets.reduce((sum, bucket) => sum + bucket.bytes, 0),
        publicBuckets: buckets.filter((bucket) => bucket.settings?.publicAccess.enabled).length,
        corsPolicies: buckets.filter((bucket) => (bucket.settings?.corsRules.length ?? 0) > 0).length,
      },
    })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to load buckets") }, { status: 500 })
  }
}
