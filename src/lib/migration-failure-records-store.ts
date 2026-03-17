import crypto from "crypto"
import { getSupabaseServerClient } from "./supabase"

const FAILURE_RECORDS_TABLE = "drive_migration_item_failure_records"

export type MigrationFailureRecordInput = {
  migrationItemId: string
  objectKey: string
  message: string
  occurredAtText?: string | null
  rawLog?: unknown
  sourceProbe?: unknown
  destinationProbe?: unknown
  diagnosis?: unknown
  download?: unknown
  fetchedAt?: string
}

export type MigrationFailureRecord = {
  objectKey: string
  message: string
  occurredAtText?: string | null
  rawLog?: unknown
  sourceProbe?: unknown
  destinationProbe?: unknown
  diagnosis?: unknown
  download?: unknown
  fetchedAt?: string
}

function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

export async function replaceMigrationItemFailureRecords(
  migrationItemId: string,
  records: MigrationFailureRecordInput[]
): Promise<void> {
  const supabase = getSupabaseServerClient()
  const now = new Date().toISOString()

  const { error: deleteError } = await supabase
    .from(FAILURE_RECORDS_TABLE)
    .delete()
    .eq("migration_item_id", migrationItemId)

  if (deleteError) throw new Error(String(deleteError.message ?? "Unable to delete previous failure records"))
  if (records.length === 0) return

  const rows = records.map((record) => ({
    id: crypto.randomUUID(),
    migration_item_id: migrationItemId,
    object_key: record.objectKey,
    message: record.message,
    occurred_at_text: record.occurredAtText ?? "",
    occurred_at: toIsoOrNull(record.occurredAtText),
    raw_log: record.rawLog ?? null,
    source_probe: record.sourceProbe ?? null,
    destination_probe: record.destinationProbe ?? null,
    diagnosis: record.diagnosis ?? null,
    download: record.download ?? null,
    fetched_at: record.fetchedAt ?? now,
    updated_at: now,
  }))

  const { error: insertError } = await supabase.from(FAILURE_RECORDS_TABLE).insert(rows)
  if (insertError) throw new Error(String(insertError.message ?? "Unable to store failure records"))
}

export async function listMigrationItemFailureRecords(
  migrationItemId: string,
  limit = 500
): Promise<MigrationFailureRecord[]> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(FAILURE_RECORDS_TABLE)
    .select("*")
    .eq("migration_item_id", migrationItemId)
    .order("occurred_at", { ascending: false, nullsFirst: false })
    .limit(Math.max(1, Math.min(1000, limit)))

  if (error) throw new Error(String(error.message ?? "Unable to load failure records"))

  return (Array.isArray(data) ? data : []).map((row: any) => ({
    objectKey: typeof row.object_key === "string" ? row.object_key : "",
    message: typeof row.message === "string" ? row.message : "",
    occurredAtText: typeof row.occurred_at_text === "string" ? row.occurred_at_text : null,
    rawLog: row.raw_log ?? null,
    sourceProbe: row.source_probe ?? null,
    destinationProbe: row.destination_probe ?? null,
    diagnosis: row.diagnosis ?? null,
    download: row.download ?? null,
    fetchedAt: typeof row.fetched_at === "string" ? row.fetched_at : undefined,
  }))
}
