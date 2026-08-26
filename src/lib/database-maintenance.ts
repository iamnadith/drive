import { isPostgresConfigured, queryDb } from "./db"

const API_EVENT_RETENTION_DAYS = 7
const OBJECT_CHANGE_RETENTION_DAYS = 7
const SCAN_DETAIL_RETENTION_DAYS = 7
const OPERATION_HISTORY_RETENTION_DAYS = 30
const ACTIVITY_RETENTION_DAYS = 90
const MAINTENANCE_INTERVAL_HOURS = 6

type MaintenanceResult = {
  ran: boolean
  deleted: Record<string, number>
  compactedMigrations: number
}

async function ensureMaintenanceSchema() {
  await queryDb(`do $$ begin
    if to_regclass('public.drive_bucket_stat_history') is not null
       and to_regclass('public.drive_storage_stats_history') is null then
      alter table public.drive_bucket_stat_history rename to drive_storage_stats_history;
    end if;
  end $$`)
  await queryDb(`
    create table if not exists drive_maintenance_state (
      task_name text primary key,
      last_run_at timestamptz not null default now(),
      last_result jsonb not null default '{}'::jsonb
    )
  `)
  await queryDb(`
    create table if not exists drive_storage_stats_history (
      id bigint generated always as identity primary key,
      account_id uuid not null,
      account_label text,
      account_email text,
      bucket_name text not null,
      previous_objects bigint,
      objects bigint not null default 0,
      object_delta bigint not null default 0,
      previous_bytes bigint,
      bytes bigint not null default 0,
      byte_delta bigint not null default 0,
      change_type text not null,
      changed_at timestamptz not null default now()
    )
  `)
  await queryDb(`create index if not exists drive_storage_stats_history_bucket_time_idx on drive_storage_stats_history (account_id, bucket_name, changed_at desc)`)
  await queryDb(`create index if not exists drive_storage_stats_history_time_idx on drive_storage_stats_history (changed_at desc)`)
  await queryDb(`alter table if exists drive_migrations add column if not exists summary_item_count integer not null default 0`)
  await queryDb(`alter table if exists drive_migrations add column if not exists summary_objects bigint not null default 0`)
  await queryDb(`alter table if exists drive_migrations add column if not exists summary_bytes bigint not null default 0`)
  await queryDb(`alter table if exists drive_migrations add column if not exists worker_summary jsonb not null default '{}'::jsonb`)
  await queryDb(`alter table if exists drive_migrations add column if not exists details_compacted_at timestamptz`)
}

async function claimMaintenance(force: boolean): Promise<boolean> {
  const { rows } = await queryDb<{ task_name: string }>(
    `
      insert into drive_maintenance_state (task_name, last_run_at)
      values ('retention', now())
      on conflict (task_name) do update set last_run_at = excluded.last_run_at
      where $1::boolean
         or drive_maintenance_state.last_run_at < now() - ($2::text || ' hours')::interval
      returning task_name
    `,
    [force, MAINTENANCE_INTERVAL_HOURS]
  )
  return rows.length > 0
}

async function deleteInBatches(input: {
  table: string
  condition: string
  params?: readonly unknown[]
  batchSize: number
  maxBatches: number
}): Promise<number> {
  let total = 0
  for (let batch = 0; batch < input.maxBatches; batch += 1) {
    const { rowCount } = await queryDb(
      `
        with doomed as (
          select ctid from ${input.table}
          where ${input.condition}
          limit ${Math.max(1, Math.floor(input.batchSize))}
        )
        delete from ${input.table}
        where ctid in (select ctid from doomed)
      `,
      input.params
    )
    const deleted = rowCount ?? 0
    total += deleted
    if (deleted < input.batchSize) break
  }
  return total
}

async function backfillBucketHistory() {
  await queryDb(`
    insert into drive_storage_stats_history (
      account_id, account_label, account_email, bucket_name,
      previous_objects, objects, object_delta,
      previous_bytes, bytes, byte_delta, change_type, changed_at
    )
    select s.account_id, a.label, a.email, s.bucket_name,
           null, s.objects, s.objects,
           null, s.bytes, s.bytes,
           'created', coalesce(s.updated_at, now())
    from drive_bucket_stats s
    left join drive_accounts a on a.id = s.account_id
      where not exists (
        select 1 from drive_storage_stats_history h
      where h.account_id = s.account_id and h.bucket_name = s.bucket_name
    )
  `)
  await queryDb(`
    insert into drive_storage_stats_history (
      account_id, account_label, account_email, bucket_name,
      previous_objects, objects, object_delta,
      previous_bytes, bytes, byte_delta, change_type, changed_at
    )
    select s.account_id, s.account_label, s.account_email, s.bucket_name,
           null, s.objects, s.objects,
           null, s.bytes, s.bytes,
           'deleted', coalesce(s.source_updated_at, s.captured_at, now())
    from drive_analytics_bucket_snapshots s
      where not exists (
        select 1 from drive_storage_stats_history h
      where h.account_id = s.account_id and h.bucket_name = s.bucket_name
    )
  `)
}

export async function compactPreviousMigrationDetails(completedMigrationId?: string): Promise<number> {
  if (!isPostgresConfigured()) return 0
  await ensureMaintenanceSchema()

  const { rows } = await queryDb<{ id: string }>(
    `
      with cutoff as (
        select created_at
        from drive_migrations
        where status = 'completed'
          and ($1::uuid is null or id = $1)
        order by created_at desc
        limit 1
      ), candidates as (
        select m.id
        from drive_migrations m, cutoff c
        where m.created_at < c.created_at
          and m.status in ('completed', 'failed', 'canceled')
          and m.details_compacted_at is null
          and exists (select 1 from drive_migration_items i where i.migration_id = m.id)
      ), totals as (
        select i.migration_id,
               count(*)::integer as item_count,
               coalesce(sum(i.source_objects), 0)::bigint as objects,
               coalesce(sum(i.source_bytes), 0)::bigint as bytes
        from drive_migration_items i
        join candidates c on c.id = i.migration_id
        group by i.migration_id
      )
      update drive_migrations m
      set summary_item_count = totals.item_count,
          summary_objects = totals.objects,
          summary_bytes = totals.bytes,
          details_compacted_at = now(),
          updated_at = now()
      from totals
      where m.id = totals.migration_id
      returning m.id
    `,
    [completedMigrationId ?? null]
  )

  if (rows.length === 0) return 0
  const ids = rows.map((row) => row.id)
  await queryDb(
    `
      update drive_migrations m
      set worker_summary = jsonb_build_object(
        'repairJobs', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', r.id,
            'status', r.status,
            'mode', r.mode,
            'requestedByAgentId', r.requested_by_agent_id,
            'claimedByAgentId', r.claimed_by_agent_id,
            'summary', r.summary,
            'error', r.error,
            'startedAt', r.started_at,
            'completedAt', r.completed_at,
            'createdAt', r.created_at
          ) order by r.created_at)
          from drive_repair_jobs r
          where r.migration_id = m.id
        ), '[]'::jsonb),
        'workerRuns', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', a.id,
            'agentId', a.agent_id,
            'runType', a.run_type,
            'status', a.status,
            'externalRunId', a.external_run_id,
            'jobReference', a.job_reference,
            'summary', a.summary,
            'startedAt', a.started_at,
            'completedAt', a.completed_at,
            'createdAt', a.created_at
          ) order by a.created_at)
          from drive_agent_runs a
          where a.payload->>'migrationId' = m.id::text
             or exists (
               select 1 from drive_repair_jobs r
               where r.migration_id = m.id and r.id::text = a.job_reference
             )
        ), '[]'::jsonb)
      ),
      updated_at = now()
      where m.id = any($1::uuid[])
    `,
    [ids]
  )
  await queryDb(
    `
      delete from drive_agent_runs a
      where a.payload->>'migrationId' = any($1::text[])
         or exists (
           select 1 from drive_repair_jobs r
           where r.migration_id = any($2::uuid[]) and r.id::text = a.job_reference
         )
    `,
    [ids, ids]
  )
  await queryDb(`delete from drive_repair_jobs where migration_id = any($1::uuid[])`, [ids])
  await queryDb(`delete from drive_migration_items where migration_id = any($1::uuid[])`, [ids])
  return ids.length
}

export async function runDatabaseMaintenance(options?: {
  force?: boolean
  exhaustive?: boolean
}): Promise<MaintenanceResult> {
  if (!isPostgresConfigured()) return { ran: false, deleted: {}, compactedMigrations: 0 }
  await ensureMaintenanceSchema()
  if (!(await claimMaintenance(options?.force === true))) {
    return { ran: false, deleted: {}, compactedMigrations: 0 }
  }

  await backfillBucketHistory()
  const maxBatches = options?.exhaustive ? 100 : 4
  const deleted: Record<string, number> = {}

  deleted.apiEvents = await deleteInBatches({
    table: "drive_project_api_events",
    condition: `occurred_at < now() - ($1::text || ' days')::interval`,
    params: [API_EVENT_RETENTION_DAYS], batchSize: 5000, maxBatches,
  })
  deleted.objectChanges = await deleteInBatches({
    table: "drive_object_change_events",
    condition: `occurred_at < now() - ($1::text || ' days')::interval`,
    params: [OBJECT_CHANGE_RETENTION_DAYS], batchSize: 5000, maxBatches,
  })
  deleted.scanObjects = await deleteInBatches({
    table: "drive_bucket_scan_objects",
    condition: `created_at < now() - ($1::text || ' days')::interval`,
    params: [SCAN_DETAIL_RETENTION_DAYS], batchSize: 5000, maxBatches,
  })
  deleted.verifyDiffs = await deleteInBatches({
    table: "drive_bucket_verify_diffs",
    condition: `created_at < now() - ($1::text || ' days')::interval`,
    params: [SCAN_DETAIL_RETENTION_DAYS], batchSize: 5000, maxBatches,
  })
  deleted.syncRuns = await deleteInBatches({
    table: "drive_object_sync_runs",
    condition: `status <> 'running' and coalesce(completed_at, started_at) < now() - ($1::text || ' days')::interval`,
    params: [SCAN_DETAIL_RETENTION_DAYS], batchSize: 1000, maxBatches,
  })
  deleted.bucketScans = await deleteInBatches({
    table: "drive_bucket_scans",
    condition: `status in ('completed', 'failed') and coalesce(completed_at, updated_at) < now() - ($1::text || ' days')::interval`,
    params: [SCAN_DETAIL_RETENTION_DAYS], batchSize: 1000, maxBatches,
  })
  deleted.operationJobs = await deleteInBatches({
    table: "drive_project_operation_jobs",
    condition: `status in ('completed', 'failed', 'canceled') and coalesce(completed_at, updated_at) < now() - ($1::text || ' days')::interval`,
    params: [OPERATION_HISTORY_RETENTION_DAYS], batchSize: 1000, maxBatches,
  })
  deleted.activityEvents = await deleteInBatches({
    table: "drive_activity_events",
    condition: `occurred_at < now() - ($1::text || ' days')::interval`,
    params: [ACTIVITY_RETENTION_DAYS], batchSize: 5000, maxBatches,
  })
  deleted.expiredLocks = await deleteInBatches({
    table: "drive_project_object_locks",
    condition: `expires_at is not null and expires_at < now()`,
    batchSize: 1000, maxBatches,
  })
  deleted.emailTokens = await deleteInBatches({
    table: "drive_email_verification_tokens",
    condition: `(expires_at < now() or consumed_at is not null) and created_at < now() - interval '1 day'`,
    batchSize: 1000, maxBatches,
  })
  deleted.smsTokens = await deleteInBatches({
    table: "drive_sms_verification_tokens",
    condition: `(expires_at < now() or consumed_at is not null) and created_at < now() - interval '1 day'`,
    batchSize: 1000, maxBatches,
  })

  const compactedMigrations = await compactPreviousMigrationDetails()
  await queryDb(
    `update drive_maintenance_state set last_result = $2::jsonb where task_name = $1`,
    ["retention", JSON.stringify({ deleted, compactedMigrations, completedAt: new Date().toISOString() })]
  )
  return { ran: true, deleted, compactedMigrations }
}

export function scheduleDatabaseMaintenance() {
  void runDatabaseMaintenance().catch((error) => {
    console.error("Database maintenance failed:", error)
  })
}
