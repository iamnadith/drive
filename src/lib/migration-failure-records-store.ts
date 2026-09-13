import crypto from "crypto"
import { queryDb, withDbTransaction } from "./db"

const FAILURE_RECORDS_TABLE = "drive_migration_item_failure_records"

type FailureRecordRow = {
  object_key: string | null
  message: string | null
  occurred_at_text: string | null
  raw_log: unknown
  source_probe: unknown
  destination_probe: unknown
  diagnosis: unknown
  download: unknown
  fetched_at: string | null
}

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
  const now = new Date().toISOString()
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

  await withDbTransaction(async (client) => {
    await client.query(`delete from public.${FAILURE_RECORDS_TABLE} where migration_item_id = $1`, [migrationItemId])
    if (rows.length === 0) return

    const values: unknown[] = []
    const tuples = rows.map((row) => {
      values.push(
        row.id,
        row.migration_item_id,
        row.object_key,
        row.message,
        row.occurred_at_text,
        row.occurred_at,
        row.raw_log,
        row.source_probe,
        row.destination_probe,
        row.diagnosis,
        row.download,
        row.fetched_at,
        row.updated_at
      )
      const base = values.length - 12
      return `(${Array.from({ length: 13 }, (_, index) => `$${base + index + 1}`).join(", ")})`
    })
    await client.query(
      `insert into public.${FAILURE_RECORDS_TABLE} (
         id, migration_item_id, object_key, message, occurred_at_text,
         occurred_at, raw_log, source_probe, destination_probe, diagnosis,
         download, fetched_at, updated_at
       ) values ${tuples.join(", ")}`,
      values
    )
  })
}

export async function listMigrationItemFailureRecords(
  migrationItemId: string,
  limit = 500
): Promise<MigrationFailureRecord[]> {
  const boundedLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
  const { rows } = await queryDb<FailureRecordRow>(
    `select object_key, message, occurred_at_text, raw_log, source_probe,
            destination_probe, diagnosis, download, fetched_at
     from public.${FAILURE_RECORDS_TABLE}
     where migration_item_id = $1
     order by occurred_at desc nulls last, fetched_at desc, id desc
     limit $2`,
    [migrationItemId, boundedLimit]
  )

  return rows.map((row) => ({
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
