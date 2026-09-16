import { NextResponse } from "next/server"

import { ensureDriveSchema, queryDb } from "@/lib/db"
import { requireAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type PoolResult = Awaited<ReturnType<typeof readPool>>
const responseCache = new Map<string, { expiresAt: number; promise: Promise<PoolResult> }>()

function hasCompleteSnapshot(snapshot: Record<string, unknown>) {
  return Array.isArray(snapshot.buckets) && Number.isFinite(Number(snapshot.totalJobs))
}

async function readPool(id: string) {
  await ensureDriveSchema()
  const { rows } = await queryDb<{
    snapshot: Record<string, unknown> | null
    snapshot_updated_at: string | null
    online_workers: string | number
    active_transfers: string | number
    total_jobs: string | number
    queued_jobs: string | number
    running_jobs: string | number
    completed_jobs: string | number
    failed_jobs: string | number
    transferred_objects: string | number
    failed_objects: string | number
    skipped_objects: string | number
    canceled_jobs: string | number
    jobs: Array<Record<string, unknown>> | null
    buckets: Array<Record<string, unknown>> | null
  }>(`
    with state as materialized (
      select snapshot,updated_at
      from public.drive_migration_worker_live_state
      where migration_id=$1
      limit 1
    ), fallback_needed as materialized (
      select not exists(
        select 1 from state
        where jsonb_typeof(snapshot->'buckets')='array'
          and jsonb_typeof(snapshot->'totalJobs')='number'
      ) needs_legacy
    ), job_counts as (
      select count(*)::bigint total_jobs,
        count(*) filter(where status='pending')::bigint queued_jobs,
        count(*) filter(where status in('claimed','running'))::bigint running_jobs,
        count(*) filter(where status='completed')::bigint completed_jobs,
        count(*) filter(where status='failed')::bigint failed_jobs,
        coalesce(sum(case when (result->'items'->0->>'transferred') ~ '^[0-9]+$' then (result->'items'->0->>'transferred')::bigint else 0 end),0)::bigint transferred_objects,
        coalesce(sum(case when (result->'items'->0->>'failed') ~ '^[0-9]+$' then (result->'items'->0->>'failed')::bigint when status='failed' and jsonb_typeof(result->'items')<>'array' then 1 else 0 end),0)::bigint failed_objects,
        coalesce(sum(case when (result->'items'->0->>'skipped') ~ '^[0-9]+$' then (result->'items'->0->>'skipped')::bigint else 0 end),0)::bigint skipped_objects,
        count(*) filter(where status='canceled')::bigint canceled_jobs
      from public.drive_repair_jobs
      where migration_id=$1 and mode='migration'
        and (select needs_legacy from fallback_needed)
    ), recent_jobs as materialized (
      select id,claimed_by_agent_id,status,progress,result,created_at
      from public.drive_repair_jobs
      where migration_id=$1 and mode='migration'
      order by created_at desc,id desc
      limit 100
    ), telemetry as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,
        'claimed_by_agent_id',claimed_by_agent_id,
        'status',status,
        'progress',jsonb_build_object(
          'fileEvents',coalesce((
            select jsonb_agg(event.value order by event.ordinality)
            from (
              select value,ordinality
              from jsonb_array_elements(case when jsonb_typeof(progress->'fileEvents')='array' then progress->'fileEvents' else '[]'::jsonb end) with ordinality
              order by ordinality desc limit 25
            ) event
          ),'[]'::jsonb),
          'logs',coalesce((
            select jsonb_agg(entry.value order by entry.ordinality)
            from (
              select value,ordinality
              from jsonb_array_elements(case when jsonb_typeof(progress->'logs')='array' then progress->'logs' else '[]'::jsonb end) with ordinality
              order by ordinality desc limit 25
            ) entry
          ),'[]'::jsonb)
        ),
        'result',jsonb_build_object('fileEvents',coalesce((
          select jsonb_agg(event.value order by event.ordinality)
          from (
            select value,ordinality
            from jsonb_array_elements(case when jsonb_typeof(result->'fileEvents')='array' then result->'fileEvents' else '[]'::jsonb end) with ordinality
            order by ordinality desc limit 25
          ) event
        ),'[]'::jsonb))
      ) order by created_at desc,id desc),'[]'::jsonb) jobs
      from recent_jobs
    ), bucket_projection as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',item.id,
        'sourceBucket',item.source_bucket,
        'targetBucket',item.target_bucket,
        'status',coalesce(nullif(item.progress->'live'->>'status',''),item.slurper_status,'pending'),
        'totalObjects',case when item.progress->'live'->>'totalObjects' ~ '^-?[0-9]+(\\.[0-9]+)?$' then (item.progress->'live'->>'totalObjects')::numeric else coalesce(item.source_objects,0) end,
        'transferredObjects',case when item.progress->'live'->>'transferredObjects' ~ '^-?[0-9]+(\\.[0-9]+)?$' then (item.progress->'live'->>'transferredObjects')::numeric else 0 end,
        'failedObjects',case when item.progress->'live'->>'failedObjects' ~ '^-?[0-9]+(\\.[0-9]+)?$' then (item.progress->'live'->>'failedObjects')::numeric else 0 end,
        'skippedObjects',case when item.progress->'live'->>'skippedObjects' ~ '^-?[0-9]+(\\.[0-9]+)?$' then (item.progress->'live'->>'skippedObjects')::numeric else 0 end,
        'transferredBytes',case when item.progress->'live'->>'transferredBytes' ~ '^-?[0-9]+(\\.[0-9]+)?$' then (item.progress->'live'->>'transferredBytes')::numeric else 0 end,
        'sourceBytes',coalesce(item.source_bytes,0),
        'updatedAt',item.updated_at
      ) order by item.source_bucket,item.id),'[]'::jsonb) buckets
      from public.drive_migration_items item
      where item.migration_id=$1 and (select needs_legacy from fallback_needed)
    ), worker_counts as (
      select count(*) filter(where r.status='running' and a.status='online'
          and a.last_heartbeat_at > now() - interval '90 seconds')::bigint online_workers,
        count(*) filter(where r.status='running' and j.progress ? 'currentFile'
          and a.status='online' and a.last_heartbeat_at > now() - interval '90 seconds')::bigint active_transfers
      from public.drive_agent_runs r
      join public.drive_agents a on a.id=r.agent_id
      left join public.drive_repair_jobs j on j.id::text=r.job_reference
      where r.run_type='github_dispatch' and r.payload->>'migrationId'=($1::uuid)::text
    )
    select state.snapshot,state.updated_at snapshot_updated_at,
      worker_counts.online_workers,worker_counts.active_transfers,
      job_counts.total_jobs,job_counts.queued_jobs,job_counts.running_jobs,
      job_counts.completed_jobs,job_counts.failed_jobs,job_counts.transferred_objects,job_counts.failed_objects,job_counts.canceled_jobs,
      telemetry.jobs,bucket_projection.buckets
    from job_counts cross join worker_counts cross join telemetry cross join bucket_projection
    left join state on true
  `, [id])
  const stateRow = rows[0]
  if (!stateRow) throw new Error("Migration worker pool query returned no row")
  const saved = stateRow.snapshot ?? {}
  const allJobs = stateRow.jobs ?? []
  const liveCounts = {
    onlineWorkers: Number(stateRow.online_workers || 0),
    activeTransfers: Number(stateRow.active_transfers || 0),
  }
  if (hasCompleteSnapshot(saved)) {
    return { snapshot: { ...saved, ...liveCounts }, snapshotUpdatedAt: stateRow.snapshot_updated_at, jobs: allJobs }
  }

  // Legacy migrations may not have an orchestrator snapshot yet. This narrow
  // bucket projection is built in the same round trip as the live queue data.
  const buckets = stateRow.buckets ?? []
  const snapshot = {
    ...saved,
    totalJobs: Number(stateRow.total_jobs || 0),
    queuedJobs: Number(stateRow.queued_jobs || 0),
    runningJobs: Number(stateRow.running_jobs || 0),
    completedJobs: Number(stateRow.completed_jobs || 0),
    failedJobs: Number(stateRow.failed_jobs || 0),
    transferred: Number(stateRow.transferred_objects || 0),
    failed: Number(stateRow.failed_objects || 0),
    skipped: Number(stateRow.skipped_objects || 0),
    canceledJobs: Number(stateRow.canceled_jobs || 0),
    totalObjects: buckets.reduce((sum, bucket) => sum + Number(bucket.totalObjects || 0), 0),
    ...liveCounts,
    buckets,
  }
  return { snapshot, snapshotUpdatedAt: stateRow.snapshot_updated_at, jobs: allJobs }
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

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response
    const { id } = await context.params
    const saved = await cachedPool(id)
    return NextResponse.json({ ...saved, source: "database" }, { headers: { "Cache-Control": "no-store, max-age=0" } })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store, max-age=0", "X-Drive-Worker-Failure": "1" } }
    )
  }
}
