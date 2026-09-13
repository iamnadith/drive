import { NextResponse } from "next/server"

import { getMigration, listMigrationItems } from "@/lib/migrations-store"
import { getMigrationOrchestratorSettings } from "@/lib/migration-orchestrator-settings-store"
import { requireAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The panel only queues a Migration Orchestrator cycle. Inventory,
 * object verification, bucket settings and worker reconciliation are owned by
 * the scanner/orchestrator workers; this route only returns persisted state.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  try {
    const { id } = await context.params
    const migration = await getMigration(id)
    if (!migration) return NextResponse.json({ error: "Migration not found" }, { status: 404 })

    let orchestrator = { signaled: false as boolean, result: null as unknown }
    if (["running", "verifying"].includes(migration.status)) {
      const settings = await getMigrationOrchestratorSettings()
      if (!settings.migrationEnabled || !settings.orchestratorUrl || settings.sharedSecret.length < 24) {
        return NextResponse.json({ error: "Migration Orchestrator is not configured and enabled" }, { status: 503 })
      }
      const response = await fetch(`${settings.orchestratorUrl}/wake`, {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.sharedSecret}` },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      })
      const result: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        return NextResponse.json({ error: "Migration Orchestrator rejected the cycle request", result }, { status: 503 })
      }
      orchestrator = { signaled: true, result: result ?? { queued: true } }
    }

    const [latestMigration, items] = await Promise.all([getMigration(id), listMigrationItems(id)])
    return NextResponse.json({
      migration: latestMigration ?? migration,
      items,
      orchestrator,
    }, { headers: { "Cache-Control": "no-store, max-age=0" } })
  } catch (error) {
    console.error("Migration Orchestrator cycle request failed", error)
    return NextResponse.json({ error: error instanceof Error ? error.message : "Migration cycle request failed" }, { status: 503 })
  }
}
