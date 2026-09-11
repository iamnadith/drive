import { NextResponse } from "next/server"

import { ensureDriveSchema, queryDb } from "@/lib/db"
import { getMigrationOrchestratorSettings } from "@/lib/migration-orchestrator-settings-store"
import { listMigrationWorkerRuns } from "@/lib/migration-worker-runs"
import { listRepairJobsByMigration } from "@/lib/repair-jobs-store"
import { requireAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function cachedPool(id: string) {
  await ensureDriveSchema()
  const [state, runs, allJobs] = await Promise.all([
    queryDb<{ snapshot: Record<string, unknown>; updated_at: string }>(`select snapshot,updated_at from drive_migration_worker_live_state where migration_id=$1 limit 1`, [id]),
    listMigrationWorkerRuns(id),
    listRepairJobsByMigration(id, 500),
  ])
  return { snapshot: state.rows[0]?.snapshot ?? null, snapshotUpdatedAt: state.rows[0]?.updated_at, runs, jobs: allJobs.filter((job) => job.mode === "migration") }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  const { id } = await context.params
  const cached = await cachedPool(id)
  if (new URL(request.url).searchParams.get("live") !== "1") {
    return NextResponse.json({ ...cached, source: "database" }, { headers: { "Cache-Control": "no-store, max-age=0" } })
  }
  try {
    const settings = await getMigrationOrchestratorSettings()
    if (!settings.orchestratorUrl || settings.sharedSecret.length < 24) throw new Error("Migration Orchestrator is not configured")
    const response = await fetch(`${settings.orchestratorUrl}/migrations/${encodeURIComponent(id)}/live`, {
      headers: { Authorization: `Bearer ${settings.sharedSecret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    })
    const live = await response.json().catch(() => ({})) as { snapshot?: Record<string, unknown>; jobs?: unknown[]; error?: string }
    if (!response.ok) throw new Error(live.error || `Migration Orchestrator returned HTTP ${response.status}`)
    return NextResponse.json({ ...cached, snapshot: live.snapshot ?? cached.snapshot, jobs: Array.isArray(live.jobs) ? live.jobs : cached.jobs, source: "orchestrator" }, { headers: { "Cache-Control": "no-store, max-age=0" } })
  } catch (error) {
    return NextResponse.json({ ...cached, source: "database", liveWarning: error instanceof Error ? error.message : String(error) }, { headers: { "Cache-Control": "no-store, max-age=0" } })
  }
}
