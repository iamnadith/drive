import crypto from "crypto"
import { getSupabaseServerClient } from "./supabase"
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

type ScanObjectRow = {
  key: string
  size: number
  isDirMarker?: boolean
}

function supabaseErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message
  }
  return String(error ?? "")
}

function isSchemaCacheMissingColumn(error: unknown, column: string): boolean {
  const message = supabaseErrorMessage(error).toLowerCase()
  if (!message.includes("schema cache")) return false
  // PostgREST messages typically include: could not find the 'col' column of 'table' in the schema cache
  return message.includes(`'${column.toLowerCase()}'`)
}

function isDirMarkerObject(input: { key: string; size: number }): boolean {
  // R2 (and some S3 tools) can store "folder markers" as 0-byte objects that end with "/".
  // Users generally do not consider these "files" and want them excluded from counts/verification.
  // We still store them in Supabase for auditability.
  return input.size === 0 && input.key.endsWith("/")
}

function mapScanRow(row: any): DriveBucketScan {
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
  const supabase = getSupabaseServerClient()
  // Reuse an active scan for the same migration item if one exists (resume),
  // otherwise create a new scan (keeps full history in DB).
  if (input.migrationItemId) {
    const { data: existing, error: existingErr } = await supabase
      .from(SCANS_TABLE)
      .select("*")
      .eq("account_id", input.accountId)
      .eq("bucket_name", input.bucketName)
      .eq("kind", input.kind)
      .eq("migration_item_id", input.migrationItemId)
      .order("updated_at", { ascending: false })
      .limit(1)

    // If the column isn't yet present (or PostgREST schema cache hasn't reloaded),
    // fall back to creating a new scan and rely on item.progress.{sourceScanId,destScanId}.
    if (existingErr) {
      if (!isSchemaCacheMissingColumn(existingErr, "migration_item_id")) {
        throw new Error(supabaseErrorMessage(existingErr) || "Unable to query bucket scans")
      }
    }
    const row = Array.isArray(existing) ? existing[0] : null
    if (row) {
      const mapped = mapScanRow(row)
      if (mapped.status === "pending" || mapped.status === "running") return mapped
    }
  }

  const now = new Date().toISOString()
  const id = crypto.randomUUID()

  const baseInsert = {
    id,
    account_id: input.accountId,
    bucket_name: input.bucketName,
    kind: input.kind,
    prefix: typeof input.prefix === "undefined" ? null : input.prefix,
    status: "pending",
    last_key: null,
    objects: 0,
    bytes: 0,
    error: null,
    started_at: null,
    completed_at: null,
    updated_at: now,
  }

  const scopedInsert = {
    ...baseInsert,
    migration_id: typeof input.migrationId === "undefined" ? null : input.migrationId,
    migration_item_id: typeof input.migrationItemId === "undefined" ? null : input.migrationItemId,
  }

  // Prefer inserting scoped columns for auditability, but gracefully fall back if the DB/schema cache
  // hasn't been updated yet.
  const tryInsert = async (payload: any) =>
    supabase.from(SCANS_TABLE).insert(payload).select("*").single()

  let result = await tryInsert(scopedInsert)
  if (result.error && (isSchemaCacheMissingColumn(result.error, "migration_id") || isSchemaCacheMissingColumn(result.error, "migration_item_id"))) {
    result = await tryInsert(baseInsert)
  }

  if (result.error) throw new Error(supabaseErrorMessage(result.error) || "Unable to create bucket scan")
  return mapScanRow(result.data as any)
}

export async function getBucketScan(scanId: string): Promise<DriveBucketScan | null> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(SCANS_TABLE).select("*").eq("id", scanId).limit(1)
  if (error) throw new Error(String((error as any)?.message ?? "Unable to load bucket scan"))
  const row = Array.isArray(data) ? data[0] : null
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
  const supabase = getSupabaseServerClient()
  const scan = await getBucketScan(input.scanId)
  if (!scan) throw new Error("Bucket scan not found")
  if (scan.status === "completed" || scan.status === "failed") return scan

  const maxKeysToProcess = Math.max(100, Math.min(25_000, input.maxObjects ?? 2_000))
  const now = new Date().toISOString()

  if (!scan.startedAt) {
    await supabase
      .from(SCANS_TABLE)
      .update({ status: "running", started_at: now, updated_at: now })
      .eq("id", input.scanId)
  }

  let keysProcessed = 0
  let objectsAdded = 0
  let bytesAdded = 0
  let lastKey = scan.lastKey ?? undefined

  while (keysProcessed < maxKeysToProcess) {
    const page = await r2ListObjectsPage(input.r2, input.bucketName, {
      prefix: typeof input.prefix === "undefined" ? undefined : input.prefix ?? undefined,
      startAfter: lastKey,
      maxKeys: Math.min(1000, maxKeysToProcess - keysProcessed),
    })

    const contents = Array.isArray(page.Contents) ? page.Contents : []
    if (contents.length === 0) {
      // Important: we might have processed one or more full 1000-key pages in this same batch.
      // If the total object count is a multiple of 1000, the next request returns empty; we must
      // still persist the counters from this run before finalizing.
      const { data, error } = await supabase
        .from(SCANS_TABLE)
        .update({
          status: "completed",
          completed_at: now,
          last_key: lastKey ?? null,
          objects: (scan.objects ?? 0) + objectsAdded,
          bytes: (scan.bytes ?? 0) + bytesAdded,
          error: null,
          updated_at: now,
        })
        .eq("id", input.scanId)
        .select("*")
        .single()
      if (error) throw new Error(String((error as any)?.message ?? "Unable to finalize bucket scan"))
      return mapScanRow(data as any)
    }

    const rows: any[] = []
    for (const obj of contents) {
      const key = typeof obj?.Key === "string" ? obj.Key : ""
      if (!key) continue
      const size = typeof obj?.Size === "number" && Number.isFinite(obj.Size) ? obj.Size : 0
      const isDirMarker = isDirMarkerObject({ key, size })
      const etag = typeof obj?.ETag === "string" ? obj.ETag : null
      const lastModified = obj?.LastModified instanceof Date ? obj.LastModified.toISOString() : null
      rows.push({
        scan_id: input.scanId,
        key,
        size,
        is_dir_marker: isDirMarker,
        etag,
        last_modified: lastModified,
        created_at: now,
      })
      lastKey = key
      keysProcessed += 1

      if (!isDirMarker) {
        objectsAdded += 1
        bytesAdded += size
      }
      if (keysProcessed >= maxKeysToProcess) break
    }

    if (rows.length > 0) {
      let upsertResult = await supabase.from(SCAN_OBJECTS_TABLE).upsert(rows, { onConflict: "scan_id,key" })
      if (upsertResult.error && isSchemaCacheMissingColumn(upsertResult.error, "is_dir_marker")) {
        const withoutFlag = rows.map((r) => {
          const { is_dir_marker: _, ...rest } = r
          return rest
        })
        upsertResult = await supabase.from(SCAN_OBJECTS_TABLE).upsert(withoutFlag, { onConflict: "scan_id,key" })
      }
      if (upsertResult.error) {
        throw new Error(supabaseErrorMessage(upsertResult.error) || "Unable to upsert bucket scan objects")
      }
    }

    // Continue while we still have room in maxObjects; stop if page smaller than requested (near end).
    if (contents.length < 1000) break
  }

  const { data, error } = await supabase
    .from(SCANS_TABLE)
    .update({
      status: "running",
      last_key: lastKey ?? null,
      objects: (scan.objects ?? 0) + objectsAdded,
      bytes: (scan.bytes ?? 0) + bytesAdded,
      updated_at: now,
    })
    .eq("id", input.scanId)
    .select("*")
    .single()
  if (error) throw new Error(String((error as any)?.message ?? "Unable to update bucket scan"))
  return mapScanRow(data as any)
}

export async function markBucketScanFailed(input: { scanId: string; error: string }): Promise<void> {
  const supabase = getSupabaseServerClient()
  const now = new Date().toISOString()
  await supabase
    .from(SCANS_TABLE)
    .update({ status: "failed", error: input.error, updated_at: now, completed_at: now })
    .eq("id", input.scanId)
}

async function loadNonDirScanObjectsPage(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  scanId: string,
  afterKey: string | null
): Promise<ScanObjectRow[]> {
  // Prefer filtering server-side by is_dir_marker, but fall back if the column isn't present yet.
  let query = supabase
    .from(SCAN_OBJECTS_TABLE)
    .select("key,size,is_dir_marker")
    .eq("scan_id", scanId)
    .eq("is_dir_marker", false)
    .order("key", { ascending: true })
    .limit(1000)

  if (afterKey) query = query.gt("key", afterKey)

  let result: any = await query
  if (result.error && isSchemaCacheMissingColumn(result.error, "is_dir_marker")) {
    let q2 = supabase
      .from(SCAN_OBJECTS_TABLE)
      .select("key,size")
      .eq("scan_id", scanId)
      .order("key", { ascending: true })
      .limit(1000)
    if (afterKey) q2 = q2.gt("key", afterKey)
    result = await q2
  }

  if (result.error) throw new Error(supabaseErrorMessage(result.error) || "Unable to read scan objects")

  const raw = Array.isArray(result.data) ? (result.data as any[]) : []
  return raw
    .map((r) => ({
      key: String(r.key ?? ""),
      size: typeof r.size === "number" ? r.size : Number(r.size ?? 0),
      isDirMarker: typeof r.is_dir_marker === "boolean" ? r.is_dir_marker : undefined,
    }))
    .filter((r) => r.key)
    .filter((r) => (typeof r.isDirMarker === "boolean" ? !r.isDirMarker : !isDirMarkerObject({ key: r.key, size: r.size })))
}

export async function inferVerifyDiffsFromScans(input: {
  sourceScanId: string
  destScanId: string
  limit?: number
  includeExtra?: boolean
}): Promise<Array<{ kind: string; key: string; sourceSize?: number | null; destSize?: number | null }>> {
  const supabase = getSupabaseServerClient()
  const limit = Math.max(1, Math.min(5_000, input.limit ?? 500))
  const includeExtra = input.includeExtra === true
  const diffs: Array<{ kind: string; key: string; sourceSize?: number | null; destSize?: number | null }> = []

  let after: string | null = null
  while (diffs.length < limit) {
    const page = await loadNonDirScanObjectsPage(supabase, input.sourceScanId, after)
    if (page.length === 0) break

    const keys = page.map((r) => r.key)
    const { data: destMatches, error: destErr } = await supabase
      .from(SCAN_OBJECTS_TABLE)
      .select("key,size,is_dir_marker")
      .eq("scan_id", input.destScanId)
      .in("key", keys)
    if (destErr) throw new Error(String((destErr as any)?.message ?? "Unable to read destination scan objects"))

    const destMap = new Map<string, number>()
    for (const r of Array.isArray(destMatches) ? (destMatches as any[]) : []) {
      const key = String((r as any).key ?? "")
      const size = typeof (r as any).size === "number" ? (r as any).size : Number((r as any).size ?? 0)
      const isDirMarker =
        typeof (r as any).is_dir_marker === "boolean"
          ? Boolean((r as any).is_dir_marker)
          : isDirMarkerObject({ key, size })
      if (key && !isDirMarker) destMap.set(key, size)
    }

    for (const row of page) {
      const destSize = destMap.get(row.key)
      if (typeof destSize === "undefined") {
        diffs.push({ kind: "missing", key: row.key, sourceSize: row.size, destSize: null })
      } else if (destSize !== row.size) {
        diffs.push({ kind: "size_mismatch", key: row.key, sourceSize: row.size, destSize })
      }
      if (diffs.length >= limit) break
    }

    after = page[page.length - 1]?.key ?? after
  }

  if (!includeExtra || diffs.length >= limit) return diffs

  let afterDest: string | null = null
  while (diffs.length < limit) {
    const page = await loadNonDirScanObjectsPage(supabase, input.destScanId, afterDest)
    if (page.length === 0) break

    const keys = page.map((r) => r.key)
    const { data: sourceMatches, error: sourceErr } = await supabase
      .from(SCAN_OBJECTS_TABLE)
      .select("key")
      .eq("scan_id", input.sourceScanId)
      .in("key", keys)
    if (sourceErr) throw new Error(String((sourceErr as any)?.message ?? "Unable to read source scan objects"))

    const sourceSet = new Set<string>(
      (Array.isArray(sourceMatches) ? sourceMatches : []).map((row: any) => String(row.key ?? "")).filter(Boolean)
    )

    for (const row of page) {
      if (!sourceSet.has(row.key)) diffs.push({ kind: "extra", key: row.key, sourceSize: null, destSize: row.size })
      if (diffs.length >= limit) break
    }

    afterDest = page[page.length - 1]?.key ?? afterDest
  }

  return diffs
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
  const supabase = getSupabaseServerClient()
  const sampleLimit = Math.max(1, Math.min(200, input.sampleLimit ?? 25))

  // Clear previous diffs for this migration item (re-run verification).
  await supabase.from(VERIFY_DIFFS_TABLE).delete().eq("migration_item_id", input.migrationItemId)

  const toDiffRow = (r: { key: string; source_size?: number | null; dest_size?: number | null }, kind: string) => ({
    id: crypto.randomUUID(),
    migration_item_id: input.migrationItemId,
    source_scan_id: input.sourceScanId,
    dest_scan_id: input.destScanId,
    kind,
    key: String(r.key ?? ""),
    source_size: typeof r.source_size === "number" ? r.source_size : r.source_size ?? null,
    dest_size: typeof r.dest_size === "number" ? r.dest_size : r.dest_size ?? null,
    created_at: new Date().toISOString(),
  })

  let missing = 0
  let sizeMismatched = 0
  let extra = 0
  const sampleMissingKeys: string[] = []
  const sampleMismatchedKeys: string[] = []
  const sampleExtraKeys: string[] = []

  const insertChunked = async (rows: any[]) => {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      const { error } = await supabase.from(VERIFY_DIFFS_TABLE).insert(chunk)
      if (error) throw new Error(String((error as any)?.message ?? "Unable to store verification diffs"))
    }
  }

  // Walk source keys and check presence/size in dest.
  let after: string | null = null
  while (true) {
    const page = await loadNonDirScanObjectsPage(supabase, input.sourceScanId, after)
    if (page.length === 0) break

    const keys = page.map((r) => r.key)
    const { data: destMatches, error: destErr } = await supabase
      .from(SCAN_OBJECTS_TABLE)
      .select("key,size,is_dir_marker")
      .eq("scan_id", input.destScanId)
      .in("key", keys)
    if (destErr) throw new Error(String((destErr as any)?.message ?? "Unable to read destination scan objects"))
    const destMap = new Map<string, number>()
    for (const r of Array.isArray(destMatches) ? (destMatches as any[]) : []) {
      const k = String((r as any).key ?? "")
      const s = typeof (r as any).size === "number" ? (r as any).size : Number((r as any).size ?? 0)
      const isDirMarker =
        typeof (r as any).is_dir_marker === "boolean"
          ? Boolean((r as any).is_dir_marker)
          : isDirMarkerObject({ key: k, size: s })
      if (k && !isDirMarker) destMap.set(k, s)
    }

    const diffsToInsert: any[] = []
    for (const r of page) {
      const dSize = destMap.get(r.key)
      if (typeof dSize === "undefined") {
        missing += 1
        if (sampleMissingKeys.length < sampleLimit) sampleMissingKeys.push(r.key)
        diffsToInsert.push(toDiffRow({ key: r.key, source_size: r.size, dest_size: null }, "missing"))
      } else if (dSize !== r.size) {
        sizeMismatched += 1
        if (sampleMismatchedKeys.length < sampleLimit) sampleMismatchedKeys.push(r.key)
        diffsToInsert.push(toDiffRow({ key: r.key, source_size: r.size, dest_size: dSize }, "size_mismatch"))
      }
    }

    if (diffsToInsert.length > 0) await insertChunked(diffsToInsert)
    after = page[page.length - 1]?.key ?? after
  }

  // Walk destination keys for extras only when strict.
  if (input.strictDestination) {
    let afterD: string | null = null
    while (true) {
      const page = await loadNonDirScanObjectsPage(supabase, input.destScanId, afterD)
      if (page.length === 0) break

      const keys = page.map((r) => r.key)
      const { data: sourceMatches, error: sourceErr2 } = await supabase
        .from(SCAN_OBJECTS_TABLE)
        .select("key")
        .eq("scan_id", input.sourceScanId)
        .in("key", keys)
      if (sourceErr2) throw new Error(String((sourceErr2 as any)?.message ?? "Unable to read source scan objects"))
      const sourceSet = new Set<string>()
      for (const r of Array.isArray(sourceMatches) ? (sourceMatches as any[]) : []) {
        const k = String((r as any).key ?? "")
        if (k) sourceSet.add(k)
      }

      const diffsToInsert: any[] = []
      for (const r of page) {
        if (sourceSet.has(r.key)) continue
        extra += 1
        if (sampleExtraKeys.length < sampleLimit) sampleExtraKeys.push(r.key)
        diffsToInsert.push(toDiffRow({ key: r.key, source_size: null, dest_size: r.size }, "extra"))
      }
      if (diffsToInsert.length > 0) await insertChunked(diffsToInsert)
      afterD = page[page.length - 1]?.key ?? afterD
    }
  }

  // If source scan had zero objects, flag it as "no files".
  const sourceScan = await getBucketScan(input.sourceScanId).catch(() => null)
  const note = sourceScan && (sourceScan.objects ?? 0) === 0 ? "no_source_objects" : undefined

  return {
    missing,
    sizeMismatched,
    extra,
    sampleMissingKeys,
    sampleMismatchedKeys,
    sampleExtraKeys,
    ...(note ? { note } : {}),
  }
}

export async function listVerifyDiffsForItem(input: {
  migrationItemId: string
  limit?: number
}): Promise<Array<{ kind: string; key: string; sourceSize?: number | null; destSize?: number | null }>> {
  const supabase = getSupabaseServerClient()
  const limit = Math.max(1, Math.min(2_000, input.limit ?? 500))
  const { data, error } = await supabase
    .from(VERIFY_DIFFS_TABLE)
    .select("kind,key,source_size,dest_size")
    .eq("migration_item_id", input.migrationItemId)
    .order("created_at", { ascending: true })
    .limit(limit)

  if (error) throw new Error(String((error as any)?.message ?? "Unable to read verification diffs"))
  return (Array.isArray(data) ? data : []).map((row: any) => ({
    kind: String(row.kind ?? ""),
    key: String(row.key ?? ""),
    sourceSize: typeof row.source_size === "number" ? row.source_size : row.source_size ?? null,
    destSize: typeof row.dest_size === "number" ? row.dest_size : row.dest_size ?? null,
  }))
}
