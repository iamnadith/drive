import { NextResponse } from "next/server"
import { authenticateBackendOrchestrator } from "@/lib/backend-orchestrator-auth"
import { runDatabaseMaintenance } from "@/lib/database-maintenance"
import { listMigrations } from "@/lib/migrations-store"
import { syncMigrationLiveState } from "@/lib/migration-live-state"
import { reconcileRepairJobs } from "@/lib/repair-jobs-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const auth = await authenticateBackendOrchestrator(request)
  if (!auth.ok) return NextResponse.json({ error: "Invalid Backend Orchestrator secret" }, { status: 401 })
  if (!auth.settings.enabled) return NextResponse.json({ error: "Backend Orchestrator is disabled" }, { status: 403 })

  const migrations = (await listMigrations(100))
    .filter((migration) => ["running", "verifying"].includes(migration.status) || migration.syncStatus === "syncing")
    .slice(0, 5)
  const results = []
  for (const migration of migrations) {
    try {
      await syncMigrationLiveState(migration.id)
      results.push({ id: migration.id, ok: true })
    } catch (error) {
      results.push({ id: migration.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  await reconcileRepairJobs().catch(() => undefined)
  const maintenance = await runDatabaseMaintenance().catch(() => ({ ran: false, deleted: {}, compactedMigrations: 0 }))
  return NextResponse.json({ ok: true, migrations: results, maintenance })
}
