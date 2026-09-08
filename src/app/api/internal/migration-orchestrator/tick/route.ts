import { NextResponse } from "next/server"
import { authenticateMigrationOrchestrator } from "@/lib/migration-orchestrator-auth"
import { listMigrations } from "@/lib/migrations-store"
import {
  ensureMigrationWorkerJobs,
  finalizeCompletedMigrationWorkerShards,
  reconcileRepairJobs,
  requeueStaleMigrationWorkerJobs,
} from "@/lib/repair-jobs-store"
import { syncMigrationLiveState } from "@/lib/migration-live-state"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const auth = await authenticateMigrationOrchestrator(request)
  if (!auth.ok) return NextResponse.json({ error: "Invalid Migration Orchestrator secret" }, { status: 401 })
  if (!auth.settings.enabled) return NextResponse.json({ error: "Migration Orchestrator is disabled" }, { status: 403 })

  const candidates = (await listMigrations(200))
    .filter(
      (migration) => migration.options.executionMode === "migration_workers" && ["running", "verifying"].includes(migration.status)
    )
    // `listMigrations` is newest-first. Rotate by last service time so a
    // long-running migration cannot starve older worker migrations when more
    // than 25 are active.
    .sort((left, right) => {
      const leftTime = Date.parse(left.lastSyncedAt || left.createdAt || "")
      const rightTime = Date.parse(right.lastSyncedAt || right.createdAt || "")
      if (!Number.isFinite(leftTime)) return -1
      if (!Number.isFinite(rightTime)) return 1
      return leftTime - rightTime
    })
    .slice(0, 25)
  const results: Array<Record<string, unknown>> = []
  for (const migration of candidates) {
    try {
      const queue = await ensureMigrationWorkerJobs({ migrationId: migration.id, mode: "repair_and_verify" })
      const requeued = await requeueStaleMigrationWorkerJobs({ migrationId: migration.id }).catch(() => 0)
      const finalized = await finalizeCompletedMigrationWorkerShards(migration.id).catch(() => ({ finalized: false, shardCount: 0, jobs: 0, items: 0 }))
      await syncMigrationLiveState(migration.id, { runSettingsSync: true })
      results.push({ id: migration.id, ok: true, created: queue.created, existing: queue.existing, requeued, finalized })
    } catch (error) {
      results.push({ id: migration.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  await reconcileRepairJobs().catch(() => undefined)
  return NextResponse.json({ ok: results.every((entry) => entry.ok === true), migrations: results, ranAt: new Date().toISOString() })
}
