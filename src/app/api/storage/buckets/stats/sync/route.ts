import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { listBucketStats } from "@/lib/bucket-stats-store"
import { requireAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"

// Compatibility endpoint for older clients. The Worker is the only component
// that scans providers and writes storage statistics.
export async function POST() {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const active = (await getAllAccounts()).find((account) => account.status === "active")
    if (!active) {
      return NextResponse.json({ error: "No active Cloudflare account", source: "database" }, { status: 404 })
    }

    const stats = await listBucketStats(active.id)
    const complete = stats.length > 0 && stats.every((row) => row.status === "completed")
    return NextResponse.json({
      ok: true,
      source: "database",
      workerOwned: true,
      complete,
      updated: stats.map((row) => ({
        bucket: row.bucketName,
        status: row.status,
        objects: row.objects,
        bytes: row.bytes,
        error: row.error,
      })),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unable to read bucket stats"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
