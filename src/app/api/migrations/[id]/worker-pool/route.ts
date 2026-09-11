import { NextResponse } from "next/server"

import { ensureDriveSchema, queryDb } from "@/lib/db"
import { getMigrationOrchestratorSettings } from "@/lib/migration-orchestrator-settings-store"
import { listMigrationWorkerRuns } from "@/lib/migration-worker-runs"
import { listMigrationItems } from "@/lib/migrations-store"
import { listRepairJobsByMigration } from "@/lib/repair-jobs-store"
import { requireAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function cachedPool(id: string) {
  await ensureDriveSchema()
  const [state, runs, allJobs, items, queue] = await Promise.all([
    queryDb<{ snapshot: Record<string, unknown>; updated_at: string }>(`select snapshot,updated_at from drive_migration_worker_live_state where migration_id=$1 limit 1`, [id]),
    listMigrationWorkerRuns(id),
    listRepairJobsByMigration(id, 500),
    listMigrationItems(id),
    queryDb<Record<string, string>>(`select count(*)::bigint total_jobs,count(*) filter(where status='pending')::bigint queued_jobs,count(*) filter(where status in('claimed','running'))::bigint running_jobs,count(*) filter(where status='completed')::bigint completed_jobs,count(*) filter(where status='failed')::bigint failed_jobs,count(*) filter(where status='canceled')::bigint canceled_jobs from drive_repair_jobs where migration_id=$1 and mode='migration'`, [id]),
  ])
  const saved = state.rows[0]?.snapshot ?? {}
  const queueRow = queue.rows[0] ?? {}
  const buckets = items.map((item) => {
    const progress = item.progress && typeof item.progress === "object" ? item.progress as Record<string, unknown> : {}
    const live = progress.live && typeof progress.live === "object" ? progress.live as Record<string, unknown> : {}
    return { id: item.id, sourceBucket: item.sourceBucket, targetBucket: item.targetBucket, status: live.status || item.slurperStatus || "pending", totalObjects: Number(live.totalObjects ?? item.sourceObjects ?? 0), transferredObjects: Number(live.transferredObjects ?? 0), failedObjects: Number(live.failedObjects ?? 0), transferredBytes: Number(live.transferredBytes ?? 0), sourceBytes: Number(item.sourceBytes ?? 0), updatedAt: item.updatedAt }
  })
  const onlineRuns = runs.filter((run) => run.online)
  const snapshot = { ...saved, totalJobs: Number(queueRow.total_jobs || 0), queuedJobs: Number(queueRow.queued_jobs || 0), runningJobs: Number(queueRow.running_jobs || 0), completedJobs: Number(queueRow.completed_jobs || 0), failedJobs: Number(queueRow.failed_jobs || 0), canceledJobs: Number(queueRow.canceled_jobs || 0), totalObjects: buckets.reduce((sum, bucket) => sum + bucket.totalObjects, 0), onlineWorkers: onlineRuns.length, activeTransfers: onlineRuns.filter((run) => run.currentFile).length, buckets }
  return { snapshot, snapshotUpdatedAt: state.rows[0]?.updated_at, runs, jobs: allJobs.filter((job) => job.mode === "migration") }
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
