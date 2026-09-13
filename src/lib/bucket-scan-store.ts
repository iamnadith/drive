import crypto from "crypto"
import { queryDb, withDbTransaction } from "./db"
import { r2ListObjectsPage, type R2ClientConfig } from "./r2-s3"

type ScanStatus = "pending" | "running" | "completed" | "failed"
type ScanKind = "source" | "dest"

export type DriveBucketScan = {
  id: string
  accountId: string
  bucketName: string
  kind: ScanKind
  migrationId?: string | null
  migrationItemId?: string | null
  prefix?: string | null
  status: ScanStatus
  lastKey?: string | null
  objects: number
  bytes: number
  error?: string | null
  startedAt?: string | null
  completedAt?: string | null
  updatedAt?: string | null
}

const SCANS_TABLE = "drive_bucket_scans"
const SCAN_OBJECTS_TABLE = "drive_bucket_scan_objects"
const VERIFY_DIFFS_TABLE = "drive_bucket_verify_diffs"

type DriveBucketScanRow = {
  id: string
  account_id: string
  bucket_name: string
  kind: string
  migration_id: string | null
  migration_item_id: string | null
  prefix: string | null
  status: string
  last_key: string | null
  objects: string | number
  bytes: string | number
  error: string | null
  started_at: string | null
  completed_at: string | null
  updated_at: string | null
  lease_owner?: string | null
  lease_expires_at?: string | null
}

function isDirMarkerObject(input: { key: string; size: number }): boolean {
  // R2 (and some S3 tools) can store "folder markers" as 0-byte objects that end with "/".
  // Users generally do not consider these "files" and want them excluded from counts/verification.
  // Keep folder markers in PostgreSQL for auditability, but exclude them from file counts.
  return input.size === 0 && input.key.endsWith("/")
}

function mapScanRow(row: DriveBucketScanRow): DriveBucketScan {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    bucketName: String(row.bucket_name),
    kind: (row.kind === "dest" ? "dest" : "source") as ScanKind,
    migrationId: row.migration_id ?? null,
    migrationItemId: row.migration_item_id ?? null,
    prefix: row.prefix ?? null,
    status: (row.status ?? "pending") as ScanStatus,
    lastKey: row.last_key ?? null,
    objects: Number(row.objects ?? 0),
    bytes: Number(row.bytes ?? 0),
    error: row.error ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

export async function ensureBucketScan(input: {
  accountId: string
  bucketName: string
  kind: ScanKind
  migrationId?: string | null
  migrationItemId?: string | null
  prefix?: string | null
}): Promise<DriveBucketScan> {
  // Reuse an active scan for the same migration item if one exists (resume),
  // otherwise create a new scan (keeps full history in DB).
  return withDbTransaction(async (client) => {
    const lockKey = `${input.accountId}:${input.bucketName}:${input.kind}:${input.migrationItemId ?? "-"}`
    await client.query(`select pg_advisory_xact_lock(hashtext('drive.bucket-scan'), hashtext($1))`, [lockKey])
    if (input.migrationItemId) {
      const existing = await client.query<DriveBucketScanRow>(
        `select * from public.${SCANS_TABLE}
         where account_id = $1 and bucket_name = $2 and kind = $3 and migration_item_id = $4
           and status in ('pending','running')
         order by updated_at desc, id desc limit 1`,
        [input.accountId, input.bucketName, input.kind, input.migrationItemId]
      )
      if (existing.rows[0]) return mapScanRow(existing.rows[0])
    }
    const { rows } = await client.query<DriveBucketScanRow>(
      `insert into public.${SCANS_TABLE} (
         id, account_id, bucket_name, kind, migration_id, migration_item_id,
         prefix, status, last_key, objects, bytes, error, started_at, completed_at, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,'pending',null,0,0,null,null,null,now())
       returning *`,
      [crypto.randomUUID(), input.accountId, input.bucketName, input.kind,
        input.migrationId ?? null, input.migrationItemId ?? null, input.prefix ?? null]
    )
    return mapScanRow(rows[0])
  })
}

export async function getBucketScan(scanId: string): Promise<DriveBucketScan | null> {
  const { rows } = await queryDb<DriveBucketScanRow>(`select * from public.${SCANS_TABLE} where id = $1 limit 1`, [scanId])
  const row = rows[0]
  return row ? mapScanRow(row) : null
}

export async function runBucketScanBatch(input: {
  scanId: string
  r2: R2ClientConfig
  bucketName: string
  prefix?: string | null
  // Upper bound on how many keys to *process* this tick (includes dir markers).
  // We count "real objects" (non-dir markers) separately for scan.objects/scan.bytes.
  maxObjects?: number
}): Promise<DriveBucketScan> {
  const leaseOwner = crypto.randomUUID()
  const claim = await queryDb<DriveBucketScanRow>(
    `update public.${SCANS_TABLE}
     set lease_owner = $2, lease_expires_at = now() + interval '2 minutes',
         attempt_count = attempt_count + 1, status = 'running',
         started_at = coalesce(started_at, now()), updated_at = now()
     where id = $1 and status in ('pending','running')
       and (lease_owner is null or lease_expires_at is null or lease_expires_at < now())
     returning *`,
    [input.scanId, leaseOwner]
  )
  const scanRow = claim.rows[0]
  if (!scanRow) {
    const current = await getBucketScan(input.scanId)
    if (!current) throw new Error("Bucket scan not found")
    if (current.status === "completed" || current.status === "failed") return current
    return current
  }
  const scan = mapScanRow(scanRow)
  const maxKeysToProcess = Math.max(100, Math.min(25_000, input.maxObjects ?? 2_000))
  let keysProcessed = 0
  let objectsAdded = 0
  let bytesAdded = 0
  let lastKey = scan.lastKey ?? undefined

  try {
    while (keysProcessed < maxKeysToProcess) {
      const renewed = await queryDb(
        `update public.${SCANS_TABLE}
         set lease_expires_at = now() + interval '2 minutes'
         where id = $1 and lease_owner = $2 and status = 'running'
         returning id`,
        [input.scanId, leaseOwner]
      )
      if ((renewed.rowCount ?? 0) === 0) throw new Error("Bucket scan lease was lost")

      const page = await r2ListObjectsPage(input.r2, input.bucketName, {
        prefix: typeof input.prefix === "undefined" ? undefined : input.prefix ?? undefined,
        startAfter: lastKey,
        maxKeys: Math.min(1000, maxKeysToProcess - keysProcessed),
      })
      const contents = Array.isArray(page.Contents) ? page.Contents : []
      if (contents.length === 0) {
        const finalized = await queryDb<DriveBucketScanRow>(
          `update public.${SCANS_TABLE} set
             status = 'completed', completed_at = now(), last_key = $3,
             objects = objects + $4, bytes = bytes + $5, error = null,
             lease_owner = null, lease_expires_at = null, updated_at = now()
           where id = $1 and lease_owner = $2 returning *`,
          [input.scanId, leaseOwner, lastKey ?? null, objectsAdded, bytesAdded]
        )
        if (!finalized.rows[0]) throw new Error("Bucket scan lease was lost before finalization")
        return mapScanRow(finalized.rows[0])
      }

      const objects: Array<Record<string, unknown>> = []
      for (const obj of contents) {
        const key = typeof obj?.Key === "string" ? obj.Key : ""
        if (!key) continue
        const size = typeof obj?.Size === "number" && Number.isFinite(obj.Size) ? obj.Size : 0
        const isDirMarker = isDirMarkerObject({ key, size })
        objects.push({
          key, size, isDirMarker,
          etag: typeof obj?.ETag === "string" ? obj.ETag : null,
          lastModified: obj?.LastModified instanceof Date ? obj.LastModified.toISOString() : null,
        })
        lastKey = key
        keysProcessed += 1
        if (!isDirMarker) {
          objectsAdded += 1
          bytesAdded += size
        }
        if (keysProcessed >= maxKeysToProcess) break
      }

      if (objects.length > 0) {
        await queryDb(
          `insert into public.${SCAN_OBJECTS_TABLE} (
             scan_id, key, size, is_dir_marker, etag, last_modified, created_at
           )
           select $1, o.key, o.size, o.is_dir_marker, o.etag, o.last_modified, now()
           from jsonb_to_recordset($2::jsonb) as o(
             key text, size bigint, is_dir_marker boolean, etag text, last_modified timestamptz
           )
           on conflict (scan_id, key) do update set
             size = excluded.size, is_dir_marker = excluded.is_dir_marker,
             etag = excluded.etag, last_modified = excluded.last_modified,
             created_at = excluded.created_at`,
          [input.scanId, JSON.stringify(objects)]
        )
      }

      if (contents.length < 1000) break
    }

    const updated = await queryDb<DriveBucketScanRow>(
      `update public.${SCANS_TABLE} set
         status = 'running', last_key = $3, objects = objects + $4,
         bytes = bytes + $5, lease_owner = null, lease_expires_at = null,
         updated_at = now()
       where id = $1 and lease_owner = $2 returning *`,
      [input.scanId, leaseOwner, lastKey ?? null, objectsAdded, bytesAdded]
    )
    if (!updated.rows[0]) throw new Error("Bucket scan lease was lost before progress was saved")
    return mapScanRow(updated.rows[0])
  } catch (error) {
    await queryDb(
      `update public.${SCANS_TABLE} set lease_owner = null, lease_expires_at = null, updated_at = now()
       where id = $1 and lease_owner = $2`,
      [input.scanId, leaseOwner]
    ).catch(() => undefined)
    throw error
  }
}

export async function markBucketScanFailed(input: { scanId: string; error: string }): Promise<void> {
  await queryDb(
    `update public.${SCANS_TABLE}
     set status = 'failed', error = $2, updated_at = now(), completed_at = now(),
         lease_owner = null, lease_expires_at = null
     where id = $1`,
    [input.scanId, input.error]
  )
}

export async function inferVerifyDiffsFromScans(input: {
  sourceScanId: string
  destScanId: string
  limit?: number
  includeExtra?: boolean
}): Promise<Array<{ kind: string; key: string; sourceSize?: number | null; destSize?: number | null }>> {
  const limit = Math.max(1, Math.min(5_000, Math.floor(input.limit ?? 500)))
  const { rows } = await queryDb<{
    kind: string
    key: string
    source_size: string | number | null
    dest_size: string | number | null
  }>(
    `with source_objects as (
       select key, size from public.${SCAN_OBJECTS_TABLE}
       where scan_id = $1 and is_dir_marker = false
     ), dest_objects as (
       select key, size from public.${SCAN_OBJECTS_TABLE}
       where scan_id = $2 and is_dir_marker = false
     ), diffs as (
       select 'missing'::text as kind, s.key, s.size as source_size, null::bigint as dest_size
       from source_objects s left join dest_objects d using (key) where d.key is null
       union all
       select 'size_mismatch', s.key, s.size, d.size
       from source_objects s join dest_objects d using (key) where s.size <> d.size
       union all
       select 'extra', d.key, null::bigint, d.size
       from dest_objects d left join source_objects s using (key)
       where $3::boolean and s.key is null
     )
     select kind, key, source_size, dest_size from diffs
     order by key asc, kind asc limit $4`,
    [input.sourceScanId, input.destScanId, input.includeExtra === true, limit]
  )
  return rows.map((row) => ({
    kind: row.kind,
    key: row.key,
    sourceSize: row.source_size === null ? null : Number(row.source_size),
    destSize: row.dest_size === null ? null : Number(row.dest_size),
  }))
}

export async function computeAndStoreVerifyDiffs(input: {
  migrationItemId: string
  sourceScanId: string
  destScanId: string
  strictDestination: boolean
  sampleLimit?: number
}): Promise<{
  missing: number
  sizeMismatched: number
  extra: number
  sampleMissingKeys: string[]
  sampleMismatchedKeys: string[]
  sampleExtraKeys: string[]
  note?: string
}> {
  const sampleLimit = Math.max(1, Math.min(200, Math.floor(input.sampleLimit ?? 25)))
  const result = await withDbTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('drive.bucket-verify'), hashtext($1))`, [input.migrationItemId])
    await client.query(
      `delete from public.${VERIFY_DIFFS_TABLE} where migration_item_id = $1`,
      [input.migrationItemId]
    )
    const { rows } = await client.query<{
      missing_count: string | number
      mismatched_count: string | number
      extra_count: string | number
      sample_missing: string[]
      sample_mismatched: string[]
      sample_extra: string[]
      source_objects: string | number | null
    }>(
      `with source_objects as materialized (
         select key, size from public.${SCAN_OBJECTS_TABLE}
         where scan_id = $2 and is_dir_marker = false
       ), dest_objects as materialized (
         select key, size from public.${SCAN_OBJECTS_TABLE}
         where scan_id = $3 and is_dir_marker = false
       ), differences as materialized (
         select 'missing'::text as kind, s.key, s.size as source_size, null::bigint as dest_size
         from source_objects s left join dest_objects d using (key) where d.key is null
         union all
         select 'size_mismatch', s.key, s.size, d.size
         from source_objects s join dest_objects d using (key) where s.size <> d.size
         union all
         select 'extra', d.key, null::bigint, d.size
         from dest_objects d left join source_objects s using (key)
         where $4::boolean and s.key is null
       ), inserted as (
         insert into public.${VERIFY_DIFFS_TABLE} (
           id, migration_item_id, source_scan_id, dest_scan_id,
           kind, key, source_size, dest_size
         )
         select gen_random_uuid(), $1, $2, $3, kind, key, source_size, dest_size
         from differences
         returning kind, key
       )
       select
         count(*) filter (where kind = 'missing') as missing_count,
         count(*) filter (where kind = 'size_mismatch') as mismatched_count,
         count(*) filter (where kind = 'extra') as extra_count,
         coalesce(array(
           select key from inserted where kind = 'missing' order by key limit $5
         ), array[]::text[]) as sample_missing,
         coalesce(array(
           select key from inserted where kind = 'size_mismatch' order by key limit $5
         ), array[]::text[]) as sample_mismatched,
         coalesce(array(
           select key from inserted where kind = 'extra' order by key limit $5
         ), array[]::text[]) as sample_extra,
         (select objects from public.${SCANS_TABLE} where id = $2) as source_objects
       from inserted`,
      [input.migrationItemId, input.sourceScanId, input.destScanId, input.strictDestination, sampleLimit]
    )
    return rows[0]
  })
  const count = (value: string | number | null | undefined) => Math.max(0, Number(value ?? 0) || 0)
  const sourceObjects = result?.source_objects
  return {
    missing: count(result?.missing_count),
    sizeMismatched: count(result?.mismatched_count),
    extra: count(result?.extra_count),
    sampleMissingKeys: Array.isArray(result?.sample_missing) ? result.sample_missing : [],
    sampleMismatchedKeys: Array.isArray(result?.sample_mismatched) ? result.sample_mismatched : [],
    sampleExtraKeys: Array.isArray(result?.sample_extra) ? result.sample_extra : [],
    ...(sourceObjects !== null && sourceObjects !== undefined && count(sourceObjects) === 0
      ? { note: "no_source_objects" }
      : {}),
  }
}

export async function listVerifyDiffsForItem(input: {
  migrationItemId: string
  limit?: number
}): Promise<Array<{ kind: string; key: string; sourceSize?: number | null; destSize?: number | null }>> {
  const limit = Math.max(1, Math.min(2_000, Math.floor(input.limit ?? 500)))
  const { rows } = await queryDb<{
    kind: string
    key: string
    source_size: string | number | null
    dest_size: string | number | null
  }>(
    `select kind, key, source_size, dest_size
     from public.${VERIFY_DIFFS_TABLE}
     where migration_item_id = $1 order by created_at asc, id asc limit $2`,
    [input.migrationItemId, limit]
  )
  return rows.map((row) => ({
    kind: row.kind,
    key: row.key,
    sourceSize: row.source_size === null ? null : Number(row.source_size),
    destSize: row.dest_size === null ? null : Number(row.dest_size),
  }))
}
