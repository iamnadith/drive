import crypto from "crypto"
import { queryDb, withDbTransaction } from "./db"

export type BucketStatsStatus = "pending" | "running" | "completed" | "error"

export type DriveBucketStats = {
  id: string
  accountId: string
  bucketName: string
  objects: number
  bytes: number
  continuationToken?: string
  status: BucketStatsStatus
  error?: string
  updatedAt?: string
}

type DriveBucketStatsRow = {
  id: string
  account_id: string
  bucket_name: string
  objects: number | string
  bytes: number | string
  continuation_token: string | null
  status: BucketStatsStatus
  error: string | null
  updated_at: string | null
}

const TABLE = "drive_bucket_stats"
let bucketStatHistorySchemaPromise: Promise<void> | null = null

async function ensureBucketStatHistorySchema() {
  bucketStatHistorySchemaPromise ??= (async () => {
    await queryDb(`do $$ begin
      if to_regclass('public.drive_bucket_stat_history') is not null
         and to_regclass('public.drive_storage_stats_history') is null then
        alter table public.drive_bucket_stat_history rename to drive_storage_stats_history;
      end if;
    end $$`)
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
  })().catch((error) => {
    bucketStatHistorySchemaPromise = null
    throw error
  })
  await bucketStatHistorySchemaPromise
}

async function recordBucketStatChange(input: {
  accountId: string
  bucketName: string
  objects: number
  bytes: number
  deleted?: boolean
}) {
  await ensureBucketStatHistorySchema()
  await queryDb(
    `
      with latest as (
        select objects, bytes, change_type
        from drive_storage_stats_history
        where account_id = $1 and bucket_name = $2
        order by changed_at desc, id desc
        limit 1
      ), account as (
        select label, email from drive_accounts where id = $1
      ), inserted as (
        insert into drive_storage_stats_history (
          account_id, account_label, account_email, bucket_name,
          previous_objects, objects, object_delta,
          previous_bytes, bytes, byte_delta, change_type
        )
        select
          $1, account.label, account.email, $2,
          latest.objects, $3,
          $3 - coalesce(latest.objects, 0),
          latest.bytes, $4,
          $4 - coalesce(latest.bytes, 0),
          case
            when $5::boolean then 'deleted'
            when latest.objects is null then 'created'
            else 'changed'
          end
        from account
        left join latest on true
        where latest.objects is null
           or latest.objects is distinct from $3
           or latest.bytes is distinct from $4
           or ($5::boolean and latest.change_type <> 'deleted')
        returning account_id, account_label, account_email, bucket_name, objects, bytes, change_type, changed_at
      )
      insert into drive_analytics_bucket_snapshots (
        account_id, account_label, account_email, bucket_name,
        objects, bytes, status, source_updated_at, captured_at
      )
      select account_id, account_label, account_email, bucket_name,
             objects, bytes,
             case when change_type = 'deleted' then 'deleted' else 'completed' end,
             changed_at, changed_at
      from inserted
      on conflict (account_id, bucket_name) do update set
        account_label = excluded.account_label,
        account_email = excluded.account_email,
        objects = excluded.objects,
        bytes = excluded.bytes,
        status = excluded.status,
        source_updated_at = excluded.source_updated_at,
        captured_at = excluded.captured_at
    `,
    [
      input.accountId,
      input.bucketName,
      Math.max(0, Math.floor(input.objects)),
      Math.max(0, Math.floor(input.bytes)),
      input.deleted === true,
    ]
  )
}

function mapRow(row: DriveBucketStatsRow): DriveBucketStats {
  const numeric = (value: number | string) => {
    const parsed = typeof value === "number" ? value : Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
  }
  return {
    id: row.id,
    accountId: row.account_id,
    bucketName: row.bucket_name,
    objects: numeric(row.objects),
    bytes: numeric(row.bytes),
    continuationToken: row.continuation_token ?? undefined,
    status: row.status,
    error: row.error ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  }
}

export async function listBucketStats(accountId: string): Promise<DriveBucketStats[]> {
  const { rows } = await queryDb<DriveBucketStatsRow>(
    `select * from public.${TABLE} where account_id = $1 order by bucket_name asc`,
    [accountId]
  )
  return rows.map(mapRow)
}

export async function listActiveBucketStats(): Promise<DriveBucketStats[]> {
  const { rows } = await queryDb<DriveBucketStatsRow>(`
    select stats.*
    from public.${TABLE} stats
    join public.drive_accounts account on account.id=stats.account_id
    where account.status='active'
    order by stats.bucket_name asc
  `)
  return rows.map(mapRow)
}

export async function getBucketStatsMap(accountId: string): Promise<Map<string, DriveBucketStats>> {
  const rows = await listBucketStats(accountId)
  const map = new Map<string, DriveBucketStats>()
  for (const row of rows) map.set(row.bucketName, row)
  return map
}

export async function resetBucketStats(accountId: string, bucketNames: string[]) {
  const names = Array.from(new Set(bucketNames.filter(Boolean)))
  if (names.length === 0) return
  await queryDb(
    `update public.${TABLE}
     set objects = 0, bytes = 0, continuation_token = null,
         status = 'pending', error = null, updated_at = now()
     where account_id = $1 and bucket_name = any($2::text[])`,
    [accountId, names]
  )
}

export async function removeMissingBucketStats(accountId: string, bucketNames: string[]) {
  const names = Array.from(new Set(bucketNames.filter(Boolean)))
  await ensureBucketStatHistorySchema()
  await withDbTransaction(async (client) => {
    await client.query(
      `with stale as materialized (
         select s.account_id, a.label as account_label, a.email as account_email,
                s.bucket_name, s.objects, s.bytes
         from public.${TABLE} s
         join public.drive_accounts a on a.id = s.account_id
         where s.account_id = $1 and not (s.bucket_name = any($2::text[]))
         for update of s
       ), latest as (
         select distinct on (h.bucket_name) h.bucket_name, h.objects, h.bytes, h.change_type
         from public.drive_storage_stats_history h
         join stale s on s.bucket_name = h.bucket_name
         where h.account_id = $1
         order by h.bucket_name, h.changed_at desc, h.id desc
       ), inserted as (
         insert into public.drive_storage_stats_history (
           account_id, account_label, account_email, bucket_name,
           previous_objects, objects, object_delta, previous_bytes, bytes,
           byte_delta, change_type
         )
         select s.account_id, s.account_label, s.account_email, s.bucket_name,
                l.objects, s.objects, s.objects - coalesce(l.objects, 0),
                l.bytes, s.bytes, s.bytes - coalesce(l.bytes, 0), 'deleted'
         from stale s left join latest l using (bucket_name)
         where l.objects is null or l.objects is distinct from s.objects
            or l.bytes is distinct from s.bytes or l.change_type <> 'deleted'
         returning account_id, account_label, account_email, bucket_name,
                   objects, bytes, changed_at
       )
       insert into public.drive_analytics_bucket_snapshots (
         account_id, account_label, account_email, bucket_name, objects,
         bytes, status, source_updated_at, captured_at
       )
       select account_id, account_label, account_email, bucket_name,
              objects, bytes, 'deleted', changed_at, changed_at
       from inserted
       on conflict (account_id, bucket_name) do update set
         account_label = excluded.account_label,
         account_email = excluded.account_email,
         objects = excluded.objects,
         bytes = excluded.bytes,
         status = excluded.status,
         source_updated_at = excluded.source_updated_at,
         captured_at = excluded.captured_at`,
      [accountId, names]
    )
    await client.query(
      `delete from public.${TABLE}
       where account_id = $1 and not (bucket_name = any($2::text[]))`,
      [accountId, names]
    )
  })
}

export async function ensureBucketStatsRows(accountId: string, bucketNames: string[]) {
  const unique = Array.from(new Set(bucketNames.filter(Boolean)))
  if (unique.length === 0) return
  // IMPORTANT: this must NOT overwrite existing rows, otherwise any polling UI would
  // reset progress back to 0/pending on every refresh.
  const values: unknown[] = []
  const tuples = unique.map((name) => {
    values.push(crypto.randomUUID(), accountId, name)
    const base = values.length - 2
    return `($${base}, $${base + 1}, $${base + 2}, 0, 0, 'pending', now())`
  })
  await queryDb(
    `insert into public.${TABLE} (
       id, account_id, bucket_name, objects, bytes, status, updated_at
     ) values ${tuples.join(", ")}
     on conflict (account_id, bucket_name) do nothing`,
    values
  )
}

export async function updateBucketStats(
  accountId: string,
  bucketName: string,
  updates: Partial<Pick<DriveBucketStats, "objects" | "bytes" | "continuationToken" | "status" | "error">>
) {
  const set: string[] = ["updated_at = now()"]
  const values: unknown[] = [accountId, bucketName]
  const add = (column: string, value: unknown) => {
    values.push(value)
    set.push(`${column} = $${values.length}`)
  }
  if (updates.objects !== undefined) add("objects", updates.objects)
  if (updates.bytes !== undefined) add("bytes", updates.bytes)
  if (updates.continuationToken !== undefined) add("continuation_token", updates.continuationToken ?? null)
  if (updates.status !== undefined) add("status", updates.status)
  if (updates.error !== undefined) add("error", updates.error ?? null)

  const { rows } = await queryDb<DriveBucketStatsRow>(
    `update public.${TABLE} set ${set.join(", ")}
     where account_id = $1 and bucket_name = $2 returning *`,
    values
  )
  if (!rows[0]) throw new Error("Bucket stats row not found")
  const mapped = mapRow(rows[0])
  if (mapped.status === "completed") {
    await recordBucketStatChange({
      accountId,
      bucketName,
      objects: mapped.objects,
      bytes: mapped.bytes,
    })
  }
  return mapped
}
