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
