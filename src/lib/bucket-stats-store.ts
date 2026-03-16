import crypto from "crypto"
import { getSupabaseServerClient } from "./supabase"

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
  objects: number
  bytes: number
  continuation_token: string | null
  status: BucketStatsStatus
  error: string | null
  updated_at: string | null
}

const TABLE = "drive_bucket_stats"

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
  return {
    id: row.id,
    accountId: row.account_id,
    bucketName: row.bucket_name,
    objects: typeof row.objects === "number" ? row.objects : 0,
    bytes: typeof row.bytes === "number" ? row.bytes : 0,
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
  return mapRow(data as DriveBucketStatsRow)
}
