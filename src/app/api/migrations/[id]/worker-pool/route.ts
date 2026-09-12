import { NextResponse } from "next/server"

import { ensureDriveSchema, queryDb } from "@/lib/db"
import { getMigrationOrchestratorSettings } from "@/lib/migration-orchestrator-settings-store"
import { listMigrationItems } from "@/lib/migrations-store"
import { listRepairJobsByMigration } from "@/lib/repair-jobs-store"
import { requireAdmin } from "@/lib/server-auth"
import { scheduleWorkerRepair } from "@/lib/worker-failure-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type PoolResult = Awaited<ReturnType<typeof readPool>>
const responseCache = new Map<string, { expiresAt: number; promise: Promise<PoolResult> }>()

function hasCompleteSnapshot(snapshot: Record<string, unknown>) {
  return Array.isArray(snapshot.buckets) && Number.isFinite(Number(snapshot.totalJobs))
}

async function readPool(id: string) {
  await ensureDriveSchema()
  const [state, allJobs] = await Promise.all([
    queryDb<{ snapshot: Record<string, unknown> | null; updated_at: string | null; online_workers: string; active_transfers: string }>(`
      select
        (select snapshot from drive_migration_worker_live_state where migration_id=$1 limit 1) snapshot,
        (select updated_at from drive_migration_worker_live_state where migration_id=$1 limit 1) updated_at,
        (select count(*)::bigint
           from drive_agent_runs r
           join drive_agents a on a.id=r.agent_id
          where r.run_type='github_dispatch' and r.payload->>'migrationId'=$1
            and r.status='running' and a.status='online'
            and a.last_heartbeat_at > now() - interval '90 seconds') online_workers,
        (select count(*)::bigint
           from drive_agent_runs r
           join drive_agents a on a.id=r.agent_id
           left join drive_repair_jobs j on j.id::text=r.job_reference
          where r.run_type='github_dispatch' and r.payload->>'migrationId'=$1
            and r.status='running' and j.progress ? 'currentFile'
            and a.status='online' and a.last_heartbeat_at > now() - interval '90 seconds') active_transfers
    `, [id]),
    listRepairJobsByMigration(id, 500),
  ])
  const stateRow = state.rows[0]
  const saved = stateRow?.snapshot ?? {}
  const liveCounts = {
    onlineWorkers: Number(stateRow?.online_workers || 0),
    activeTransfers: Number(stateRow?.active_transfers || 0),
  }
  if (hasCompleteSnapshot(saved)) {
    return { snapshot: { ...saved, ...liveCounts }, snapshotUpdatedAt: stateRow?.updated_at, jobs: allJobs.filter((job) => job.mode === "migration") }
  }

  // Legacy migrations may not have an orchestrator snapshot yet. Build this
  // fallback once; normal reads use the compact persisted snapshot above.
  const [items, queue] = await Promise.all([
    listMigrationItems(id),
    queryDb<Record<string, string>>(`select count(*)::bigint total_jobs,count(*) filter(where status='pending')::bigint queued_jobs,count(*) filter(where status in('claimed','running'))::bigint running_jobs,count(*) filter(where status='completed')::bigint completed_jobs,count(*) filter(where status='failed')::bigint failed_jobs,count(*) filter(where status='canceled')::bigint canceled_jobs from drive_repair_jobs where migration_id=$1 and mode='migration'`, [id]),
  ])
  const queueRow = queue.rows[0] ?? {}
  const buckets = items.map((item) => {
    const progress = item.progress && typeof item.progress === "object" ? item.progress as Record<string, unknown> : {}
    const live = progress.live && typeof progress.live === "object" ? progress.live as Record<string, unknown> : {}
    return { id: item.id, sourceBucket: item.sourceBucket, targetBucket: item.targetBucket, status: live.status || item.slurperStatus || "pending", totalObjects: Number(live.totalObjects ?? item.sourceObjects ?? 0), transferredObjects: Number(live.transferredObjects ?? 0), failedObjects: Number(live.failedObjects ?? 0), transferredBytes: Number(live.transferredBytes ?? 0), sourceBytes: Number(item.sourceBytes ?? 0), updatedAt: item.updatedAt }
  })
  const snapshot = { ...saved, totalJobs: Number(queueRow.total_jobs || 0), queuedJobs: Number(queueRow.queued_jobs || 0), runningJobs: Number(queueRow.running_jobs || 0), completedJobs: Number(queueRow.completed_jobs || 0), failedJobs: Number(queueRow.failed_jobs || 0), canceledJobs: Number(queueRow.canceled_jobs || 0), totalObjects: buckets.reduce((sum, bucket) => sum + bucket.totalObjects, 0), ...liveCounts, buckets }
  return { snapshot, snapshotUpdatedAt: stateRow?.updated_at, jobs: allJobs.filter((job) => job.mode === "migration") }
}

function cachedPool(id: string) {
  const now = Date.now()
  const current = responseCache.get(id)
  if (current && current.expiresAt > now) return current.promise
  const promise = readPool(id).catch((error) => {
    responseCache.delete(id)
    throw error
  })
  responseCache.set(id, { expiresAt: now + 3_000, promise })
  if (responseCache.size > 100) {
    for (const [key, entry] of responseCache) if (entry.expiresAt <= now) responseCache.delete(key)
  }
  return promise
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
    scheduleWorkerRepair()
    return NextResponse.json({ ...cached, source: "database", liveWarning: error instanceof Error ? error.message : String(error) }, { headers: { "Cache-Control": "no-store, max-age=0", "X-Drive-Worker-Failure": "1" } })
  }
}
