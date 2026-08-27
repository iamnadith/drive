import crypto from "crypto"
import { getSupabaseServerClient } from "./supabase"
import { queryDb } from "./db"

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

async function ensureBucketStatHistorySchema() {
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

function normalizeSupabaseError(error: { message: string }): Error {
  const message = String(error?.message ?? "Supabase error")
  if (message.includes("Could not find the table") && message.includes(TABLE)) {
    return new Error(
      `Supabase table '${TABLE}' is missing. Create it by running 'supabase/drive_schema.sql' in the Supabase SQL editor.`
    )
  }
  return new Error(message)
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
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(TABLE).select("*").eq("account_id", accountId)
  if (error) throw normalizeSupabaseError(error)
  return (data as DriveBucketStatsRow[]).map(mapRow)
}

export async function getBucketStatsMap(accountId: string): Promise<Map<string, DriveBucketStats>> {
  const rows = await listBucketStats(accountId)
  const map = new Map<string, DriveBucketStats>()
  for (const row of rows) map.set(row.bucketName, row)
  return map
}

export async function resetBucketStats(accountId: string, bucketNames: string[]) {
  const supabase = getSupabaseServerClient()
  const names = Array.from(new Set(bucketNames.filter(Boolean)))
  if (names.length === 0) return
  const { error } = await supabase
    .from(TABLE)
    .update({ objects: 0, bytes: 0, continuation_token: null, status: "pending", error: null, updated_at: new Date().toISOString() })
    .eq("account_id", accountId)
    .in("bucket_name", names)
  if (error) throw normalizeSupabaseError(error)
}

export async function removeMissingBucketStats(accountId: string, bucketNames: string[]) {
  const supabase = getSupabaseServerClient()
  const current = await listBucketStats(accountId)
  const names = new Set(bucketNames)
  const staleIds = current.filter((row) => !names.has(row.bucketName)).map((row) => row.id)
  if (staleIds.length === 0) return
  const staleRows = current.filter((row) => staleIds.includes(row.id))
  for (const row of staleRows) {
    await recordBucketStatChange({
      accountId,
      bucketName: row.bucketName,
      objects: row.objects,
      bytes: row.bytes,
      deleted: true,
    })
  }
  const { error } = await supabase.from(TABLE).delete().in("id", staleIds)
  if (error) throw normalizeSupabaseError(error)
}

export async function ensureBucketStatsRows(accountId: string, bucketNames: string[]) {
  const supabase = getSupabaseServerClient()
  const unique = Array.from(new Set(bucketNames.filter(Boolean)))
  if (unique.length === 0) return

  const now = new Date().toISOString()
  const rows = unique.map((name) => ({
    id: crypto.randomUUID(),
    account_id: accountId,
    bucket_name: name,
    objects: 0,
    bytes: 0,
    continuation_token: null,
    status: "pending" as const,
    error: null,
    updated_at: now,
  }))

  // IMPORTANT: this must NOT overwrite existing rows, otherwise any polling UI would
  // reset progress back to 0/pending on every refresh.
  const { error } = await supabase
    .from(TABLE)
    .upsert(rows, { onConflict: "account_id,bucket_name", ignoreDuplicates: true })
  if (error) throw normalizeSupabaseError(error)
}

export async function updateBucketStats(
  accountId: string,
  bucketName: string,
  updates: Partial<Pick<DriveBucketStats, "objects" | "bytes" | "continuationToken" | "status" | "error">>
) {
  const supabase = getSupabaseServerClient()
  const dbUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (updates.objects !== undefined) dbUpdates.objects = updates.objects
  if (updates.bytes !== undefined) dbUpdates.bytes = updates.bytes
  if (updates.continuationToken !== undefined)
    dbUpdates.continuation_token = updates.continuationToken ?? null
  if (updates.status !== undefined) dbUpdates.status = updates.status
  if (updates.error !== undefined) dbUpdates.error = updates.error ?? null

  const { data, error } = await supabase
    .from(TABLE)
    .update(dbUpdates)
    .eq("account_id", accountId)
    .eq("bucket_name", bucketName)
    .select("*")
    .single()

  if (error) throw normalizeSupabaseError(error)
  const mapped = mapRow(data as DriveBucketStatsRow)
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
