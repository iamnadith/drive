import crypto from "crypto"
import { getDbPool, queryDb } from "./db"

type ListedObject = {
  Key?: string
  Size?: number
  ETag?: string
  LastModified?: Date
}

type SyncRunRow = { id: string; account_id: string; status: string; started_at: string }

let schemaReady: Promise<void> | null = null

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await queryDb(`create extension if not exists pgcrypto`)
      await queryDb(`
        create table if not exists drive_object_sync_runs (
          id uuid primary key,
          account_id uuid not null references drive_accounts(id) on delete cascade,
          status text not null default 'running',
          error text,
          started_at timestamptz not null default now(),
          completed_at timestamptz
        )
      `)
      await queryDb(`create index if not exists drive_object_sync_runs_active_idx on drive_object_sync_runs (account_id, status, started_at desc)`)
      await queryDb(`
        create table if not exists drive_object_sync_objects (
          run_id uuid not null references drive_object_sync_runs(id) on delete cascade,
          bucket_name text not null,
          key text not null,
          size bigint not null default 0,
          etag text,
          last_modified timestamptz,
          primary key (run_id, bucket_name, key)
        )
      `)
      await queryDb(`
        create table if not exists drive_logical_object_inventory (
          bucket_name text not null,
          key text not null,
          account_id uuid not null references drive_accounts(id) on delete cascade,
          size bigint not null default 0,
          etag text,
          last_modified timestamptz,
          first_seen_at timestamptz not null default now(),
          last_seen_at timestamptz not null default now(),
          primary key (bucket_name, key)
        )
      `)
      await queryDb(`
        create table if not exists drive_object_change_events (
          id uuid primary key default gen_random_uuid(),
          run_id uuid references drive_object_sync_runs(id) on delete set null,
          occurred_at timestamptz not null default now(),
          change_type text not null,
          bucket_name text not null,
          key text not null,
          previous_size bigint,
          current_size bigint,
          account_id uuid references drive_accounts(id) on delete set null
        )
      `)
      await queryDb(`create index if not exists drive_object_change_events_time_idx on drive_object_change_events (occurred_at desc)`)
      await queryDb(`
        create table if not exists drive_logical_storage_snapshots (
          captured_day date primary key,
          captured_at timestamptz not null default now(),
          account_id uuid references drive_accounts(id) on delete set null,
          buckets integer not null default 0,
          objects bigint not null default 0,
          bytes bigint not null default 0,
          added bigint not null default 0,
          updated bigint not null default 0,
          deleted bigint not null default 0
        )
      `)
    })().catch((error) => {
      schemaReady = null
      throw error
    })
  }
  await schemaReady
}

export async function getRunningObjectSync(accountId: string): Promise<SyncRunRow | null> {
  await ensureSchema()
  const { rows } = await queryDb<SyncRunRow>(`
    select id, account_id, status, started_at
    from drive_object_sync_runs
    where account_id = $1 and status = 'running'
    order by started_at desc
    limit 1
  `, [accountId])
  return rows[0] ?? null
}

export async function startObjectSync(accountId: string): Promise<SyncRunRow> {
  await ensureSchema()
  const existing = await getRunningObjectSync(accountId)
  if (existing) return existing
  const id = crypto.randomUUID()
  const { rows } = await queryDb<SyncRunRow>(`
    insert into drive_object_sync_runs (id, account_id, status)
    values ($1, $2, 'running')
    returning id, account_id, status, started_at
  `, [id, accountId])
  return rows[0]
}

export async function stageObjectPage(runId: string, bucketName: string, objects: ListedObject[]) {
  await ensureSchema()
  const valid = objects.filter((object) => typeof object.Key === "string" && object.Key.length > 0)
  if (valid.length === 0) return
  const values: unknown[] = []
  const placeholders = valid.map((object, index) => {
    const offset = index * 6
    values.push(runId, bucketName, object.Key, Math.max(0, Number(object.Size) || 0), object.ETag ?? null, object.LastModified?.toISOString() ?? null)
    return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6})`
  })
  await queryDb(`
    insert into drive_object_sync_objects (run_id, bucket_name, key, size, etag, last_modified)
    values ${placeholders.join(",")}
    on conflict (run_id, bucket_name, key) do update set
      size = excluded.size,
      etag = excluded.etag,
      last_modified = excluded.last_modified
  `, values)
}

export async function failObjectSync(runId: string, error: string) {
  await ensureSchema()
  await queryDb(`update drive_object_sync_runs set status = 'failed', error = $2, completed_at = now() where id = $1`, [runId, error])
}

export async function completeObjectSync(runId: string, accountId: string) {
  await ensureSchema()
  const pool = getDbPool()
  const client = await pool.connect()
  try {
    await client.query("begin")
    await client.query(`
      insert into drive_object_change_events (run_id, change_type, bucket_name, key, current_size, account_id)
      select $1, 'added', s.bucket_name, s.key, s.size, $2
      from drive_object_sync_objects s
      left join drive_logical_object_inventory i on i.bucket_name = s.bucket_name and i.key = s.key
      where s.run_id = $1 and i.key is null
    `, [runId, accountId])
    await client.query(`
      insert into drive_object_change_events (run_id, change_type, bucket_name, key, previous_size, current_size, account_id)
      select $1, 'updated', s.bucket_name, s.key, i.size, s.size, $2
      from drive_object_sync_objects s
      join drive_logical_object_inventory i on i.bucket_name = s.bucket_name and i.key = s.key
      where s.run_id = $1 and (
        i.size is distinct from s.size or
        (i.account_id = $2 and i.etag is distinct from s.etag)
      )
    `, [runId, accountId])
    await client.query(`
      insert into drive_object_change_events (run_id, change_type, bucket_name, key, previous_size, account_id)
      select $1, 'deleted', i.bucket_name, i.key, i.size, $2
      from drive_logical_object_inventory i
      where not exists (
        select 1 from drive_object_sync_objects s
        where s.run_id = $1 and s.bucket_name = i.bucket_name and s.key = i.key
      )
    `, [runId, accountId])
    await client.query(`
      insert into drive_logical_object_inventory
        (bucket_name, key, account_id, size, etag, last_modified, first_seen_at, last_seen_at)
      select s.bucket_name, s.key, $2, s.size, s.etag, s.last_modified, now(), now()
      from drive_object_sync_objects s
      where s.run_id = $1
      on conflict (bucket_name, key) do update set
        account_id = excluded.account_id,
        size = excluded.size,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        last_seen_at = excluded.last_seen_at
    `, [runId, accountId])
    await client.query(`
      delete from drive_logical_object_inventory i
      where not exists (
        select 1 from drive_object_sync_objects s
        where s.run_id = $1 and s.bucket_name = i.bucket_name and s.key = i.key
      )
    `, [runId])
    const totals = await client.query<{ buckets: string; objects: string; bytes: string }>(`
      select count(distinct bucket_name)::text buckets, count(*)::text objects, coalesce(sum(size),0)::text bytes
      from drive_object_sync_objects where run_id = $1
    `, [runId])
    const changes = await client.query<{ change_type: string; count: string }>(`
      select change_type, count(*)::text count from drive_object_change_events where run_id = $1 group by change_type
    `, [runId])
    const byType = new Map(changes.rows.map((row) => [row.change_type, Number(row.count)]))
    const total = totals.rows[0] ?? { buckets: "0", objects: "0", bytes: "0" }
    await client.query(`
      insert into drive_logical_storage_snapshots
        (captured_day, captured_at, account_id, buckets, objects, bytes, added, updated, deleted)
      values (current_date, now(), $1, $2, $3, $4, $5, $6, $7)
      on conflict (captured_day) do update set
        captured_at = excluded.captured_at,
        account_id = excluded.account_id,
        buckets = excluded.buckets,
        objects = excluded.objects,
        bytes = excluded.bytes,
        added = drive_logical_storage_snapshots.added + excluded.added,
        updated = drive_logical_storage_snapshots.updated + excluded.updated,
        deleted = drive_logical_storage_snapshots.deleted + excluded.deleted
    `, [accountId, Number(total.buckets), Number(total.objects), Number(total.bytes), byType.get("added") ?? 0, byType.get("updated") ?? 0, byType.get("deleted") ?? 0])
    await client.query(`update drive_object_sync_runs set status = 'completed', completed_at = now(), error = null where id = $1`, [runId])
    await client.query(`delete from drive_object_sync_objects where run_id = $1`, [runId])
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  } finally {
    client.release()
  }
}
