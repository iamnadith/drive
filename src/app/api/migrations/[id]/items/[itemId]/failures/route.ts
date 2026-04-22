import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import {
  ensureBucketScan,
  getBucketScan,
  inferVerifyDiffsFromScans,
  listVerifyDiffsForItem,
  runBucketScanBatch,
} from "@/lib/bucket-scan-store"
import { slurperListJobLogs } from "@/lib/cloudflare-r2-super-slurper"
import { listMigrationItemFailureRecords, replaceMigrationItemFailureRecords } from "@/lib/migration-failure-records-store"
import { getMigration, listMigrationItems, updateMigrationItem } from "@/lib/migrations-store"
import { listRepairJobsByMigration } from "@/lib/repair-jobs-store"
import { r2GetObjectStream, r2HeadObject, r2ListAllObjects } from "@/lib/r2-s3"

export const runtime = "nodejs"

type FailedLogEntry = {
  key: string
  message: string
  at?: string
  raw?: unknown
  evidence?: "cloudflare_log" | "verify_sample" | "repair_worker" | "repair_job"
}

type ObjectProbe = {
  exists: boolean | null
  size?: number
  etag?: string
  lastModified?: string
  contentType?: string
  readable?: boolean | null
  error?: string
}

type Diagnosis = {
  category:
    | "source_missing"
    | "source_access_issue"
    | "destination_exists"
    | "possible_content_mismatch"
    | "transient_or_provider_issue"
    | "unknown"
  reason: string
  recommendation: string
}

type InferredVerifyDiff = {
  key: string
  kind: string
  sourceSize?: number | null
  destSize?: number | null
}

function readReportedFailedObjects(progress: Record<string, unknown>): number {
  const cumulative = isRecord(progress.slurperCumulative) ? (progress.slurperCumulative as Record<string, unknown>) : null
  if (cumulative && typeof cumulative.failedObjects === "number" && Number.isFinite(cumulative.failedObjects)) {
    return Math.max(0, Math.floor(cumulative.failedObjects))
  }

  const normalized = isRecord(progress.slurperNormalized) ? (progress.slurperNormalized as Record<string, unknown>) : null
  if (normalized && typeof normalized.failedObjects === "number" && Number.isFinite(normalized.failedObjects)) {
    return Math.max(0, Math.floor(normalized.failedObjects))
  }

  const slurper = isRecord(progress.slurper) ? (progress.slurper as Record<string, unknown>) : null
  const result = slurper && isRecord(slurper.result) ? (slurper.result as Record<string, unknown>) : null
  if (result && typeof result.failedObjects === "number" && Number.isFinite(result.failedObjects)) {
    return Math.max(0, Math.floor(result.failedObjects))
  }

  return 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getString(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = rec[key]
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return undefined
}

function isFailureLikeMessage(value: string): boolean {
  return /fail|error|retry|timeout|denied|forbidden|mismatch|missing|import/i.test(value)
}

function readNested(rec: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = rec
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function parseFailedLine(line: string): FailedLogEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const tabParts = trimmed.split("\t").map((part) => part.trim())
  if (tabParts.length >= 2) {
    const key = tabParts[0]
    const message = tabParts[1]
    const at = tabParts.length >= 3 ? tabParts[tabParts.length - 1] : undefined
    if (key && message && isFailureLikeMessage(message)) {
      return { key, message, at }
    }
  }

  const genericMatch = trimmed.match(/^(.+?)\s+Object failed to import despite retries\.?\s*$/i)
  if (genericMatch && genericMatch[1]) {
    return { key: genericMatch[1].trim(), message: "Object failed to import despite retries.", raw: line }
  }

  const quotedKeyMatch = trimmed.match(/["'`](.+?)["'`].{0,120}?(failed|error|retry|timeout|missing|mismatch|import)/i)
  if (quotedKeyMatch && quotedKeyMatch[1]) {
    return {
      key: quotedKeyMatch[1].trim(),
      message: trimmed,
      raw: line,
    }
  }

  const keyValueMatch = trimmed.match(/\b(?:key|object|path)\s*[=:]\s*([^\s,]+).{0,120}?(failed|error|retry|timeout|missing|mismatch|import)/i)
  if (keyValueMatch && keyValueMatch[1]) {
    return {
      key: keyValueMatch[1].trim(),
      message: trimmed,
      raw: line,
    }
  }

  const prefixMessageMatch = trimmed.match(/^(.+?):\s+(.+)$/)
  if (prefixMessageMatch && prefixMessageMatch[1] && prefixMessageMatch[2] && isFailureLikeMessage(prefixMessageMatch[2])) {
    return {
      key: prefixMessageMatch[1].trim(),
      message: prefixMessageMatch[2].trim(),
      raw: line,
    }
  }

  return null
}

function extractFailedEntries(logs: unknown): FailedLogEntry[] {
  const entries: FailedLogEntry[] = []
  const seen = new Set<string>()
  const visited = new WeakSet<object>()

  const maybePush = (entry: FailedLogEntry | null) => {
    if (!entry) return
    const key = entry.key.trim()
    const message = entry.message.trim()
    if (!key || !message) return
    if (!isFailureLikeMessage(message)) return
    const id = `${key}::${message}::${entry.at ?? ""}`
    if (seen.has(id)) return
    seen.add(id)
    entries.push({ key, message, at: entry.at, raw: entry.raw })
  }

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node === "string") {
      for (const line of node.split(/\r?\n/)) maybePush(parseFailedLine(line))
      return
    }
    if (!isRecord(node)) return

    if (visited.has(node)) return
    visited.add(node)

    const key =
      getString(node, ["key", "objectKey", "object_key", "path", "object", "name"]) ??
      (typeof readNested(node, ["object", "key"]) === "string" ? (readNested(node, ["object", "key"]) as string) : undefined)

    const message =
      getString(node, ["message", "msg", "error", "reason", "detail", "details"]) ??
      (typeof readNested(node, ["error", "message"]) === "string"
        ? (readNested(node, ["error", "message"]) as string)
        : undefined)

    const at =
      getString(node, ["at", "time", "timestamp", "createdAt", "created_at", "date"]) ??
      (typeof readNested(node, ["meta", "timestamp"]) === "string"
        ? (readNested(node, ["meta", "timestamp"]) as string)
        : undefined)

    if (key && message && isFailureLikeMessage(message)) {
      maybePush({ key, message, at, raw: node })
    } else if (typeof message === "string") {
      maybePush(parseFailedLine(message))
    }

    for (const value of Object.values(node)) visit(value)
  }

  visit(logs)
  return entries
}

function dedupeFailedEntries(entries: FailedLogEntry[], limit: number): FailedLogEntry[] {
  const out: FailedLogEntry[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = entry.key.trim()
    const message = entry.message.trim()
    if (!key || !message) continue
    const id = `${key}::${message}::${entry.at ?? ""}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ ...entry, key, message })
    if (out.length >= limit) break
  }
  return out
}

function readProgressFallbackEntries(progress: Record<string, unknown>, limit: number): FailedLogEntry[] {
  const entries: FailedLogEntry[] = []
  const verify = isRecord(progress.verify) ? (progress.verify as Record<string, unknown>) : null
  const verifySamples = isRecord(progress.verifySamples) ? (progress.verifySamples as Record<string, unknown>) : null
  const repairWorker = isRecord(progress.repairWorker) ? (progress.repairWorker as Record<string, unknown>) : null
  const repairDetails = repairWorker && isRecord(repairWorker.details) ? (repairWorker.details as Record<string, unknown>) : null

  const pushKeys = (keys: unknown, message: string, evidence: FailedLogEntry["evidence"]) => {
    if (!Array.isArray(keys)) return
    for (const rawKey of keys) {
      const key = typeof rawKey === "string" ? rawKey.trim() : ""
      if (!key) continue
      entries.push({ key, message, raw: { source: evidence, key }, evidence })
      if (entries.length >= limit) return
    }
  }

  pushKeys(verify?.sampleMissingKeys, "Verification found this source object missing in destination.", "verify_sample")
  pushKeys(verify?.sampleMismatchedKeys, "Verification found this object with a size mismatch in destination.", "verify_sample")
  pushKeys(verify?.sampleExtraKeys, "Verification found this unexpected object in destination.", "verify_sample")
  pushKeys(verifySamples?.missing, "Verification found this source object missing in destination.", "verify_sample")
  pushKeys(verifySamples?.mismatched, "Verification found this object with a size mismatch in destination.", "verify_sample")
  pushKeys(verifySamples?.extra, "Verification found this unexpected object in destination.", "verify_sample")

  if (Array.isArray(repairDetails?.failureSamples)) {
    for (const sample of repairDetails.failureSamples) {
      if (!isRecord(sample)) continue
      const key = typeof sample.key === "string" ? sample.key.trim() : ""
      if (!key) continue
      const message =
        typeof sample.error === "string" && sample.error.trim()
          ? sample.error.trim()
          : "Worker reported a file-level failure."
      entries.push({ key, message, raw: sample, evidence: "repair_worker" })
      if (entries.length >= limit) break
    }
  }

  return dedupeFailedEntries(entries, limit)
}

function readRepairJobFallbackEntries(
  repairJobs: Array<{ progress?: Record<string, unknown>; result?: Record<string, unknown> }>,
  itemId: string,
  limit: number
): FailedLogEntry[] {
  const entries: FailedLogEntry[] = []

  for (const job of repairJobs) {
    const fileEventsSource = Array.isArray(job.progress?.fileEvents)
      ? job.progress?.fileEvents
      : Array.isArray(job.result?.fileEvents)
        ? job.result?.fileEvents
        : []

    for (const rawEvent of fileEventsSource) {
      if (!isRecord(rawEvent)) continue
      if (typeof rawEvent.itemId === "string" && rawEvent.itemId !== itemId) continue
      const key = typeof rawEvent.key === "string" ? rawEvent.key.trim() : ""
      if (!key) continue
      const status = typeof rawEvent.status === "string" ? rawEvent.status.toLowerCase() : ""
      const kind = typeof rawEvent.kind === "string" ? rawEvent.kind.toLowerCase() : ""
      const stage = typeof rawEvent.stage === "string" ? rawEvent.stage.toLowerCase() : ""
      if (status !== "failed" && kind !== "missing" && kind !== "mismatched" && !stage.includes("verify")) continue
      const message =
        typeof rawEvent.error === "string" && rawEvent.error.trim()
          ? rawEvent.error.trim()
          : kind === "missing"
            ? "Worker detected this object missing in destination."
            : kind === "mismatched"
              ? "Worker detected this object with a size mismatch."
              : "Worker reported a file-level failure."
      const at =
        typeof rawEvent.updatedAt === "string"
          ? rawEvent.updatedAt
          : typeof rawEvent.completedAt === "string"
            ? rawEvent.completedAt
            : typeof rawEvent.startedAt === "string"
              ? rawEvent.startedAt
              : undefined
      entries.push({ key, message, at, raw: rawEvent, evidence: "repair_job" })
      if (entries.length >= limit) return dedupeFailedEntries(entries, limit)
    }

    const resultItems = Array.isArray(job.result?.items) ? job.result?.items : []
    for (const rawItem of resultItems) {
      if (!isRecord(rawItem)) continue
      if (typeof rawItem.itemId === "string" && rawItem.itemId !== itemId) continue
      const failureSamples = Array.isArray(rawItem.failureSamples) ? rawItem.failureSamples : []
      for (const sample of failureSamples) {
        if (!isRecord(sample)) continue
        const key = typeof sample.key === "string" ? sample.key.trim() : ""
        if (!key) continue
        const message =
          typeof sample.error === "string" && sample.error.trim()
            ? sample.error.trim()
            : "Worker reported a file-level failure."
        entries.push({ key, message, raw: sample, evidence: "repair_job" })
        if (entries.length >= limit) return dedupeFailedEntries(entries, limit)
      }
    }
  }

  return dedupeFailedEntries(entries, limit)
}

async function collectJobLogs(input: {
  accountId: string
  apiToken: string
  jobId: string
}): Promise<unknown[]> {
  const pages: unknown[] = []
  const maxPages = 12
  const perPage = 200

  for (let page = 1; page <= maxPages; page += 1) {
    const envelope = await slurperListJobLogs({
      accountId: input.accountId,
      apiToken: input.apiToken,
      jobId: input.jobId,
      page,
      perPage,
    }).catch(() => null)

    if (!envelope) break
    pages.push(envelope)

    const currentCount = extractFailedEntries(envelope).length
    if (currentCount === 0 && page > 1) break
  }

  // Fallback: at least one unpaged fetch if paged calls produced nothing.
  if (pages.length === 0) {
    const one = await slurperListJobLogs({
      accountId: input.accountId,
      apiToken: input.apiToken,
      jobId: input.jobId,
    }).catch(() => null)
    if (one) pages.push(one)
  }

  return pages
}

function formatProbeError(error: unknown): { exists: boolean | null; error: string } {
  const status =
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    typeof (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === "number"
      ? (error as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode
      : undefined

  const code =
    typeof error === "object" && error !== null && "Code" in error
      ? String((error as { Code?: unknown }).Code ?? "")
      : typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : ""

  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "Unknown error")
      : "Unknown error"

  if (status === 404 || /NoSuchKey/i.test(code) || /not found|no such key/i.test(message)) {
    return { exists: false, error: code || "NoSuchKey" }
  }

  return { exists: null, error: `${code ? `${code}: ` : ""}${message}` }
}

async function probeObject(input: {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  key: string
}): Promise<ObjectProbe> {
  try {
    const head = await r2HeadObject(
      {
        accountId: input.accountId,
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
      },
      input.bucket,
      input.key
    )

    return {
      exists: true,
      size: typeof head.ContentLength === "number" ? head.ContentLength : undefined,
      etag: typeof head.ETag === "string" ? head.ETag : undefined,
      lastModified: head.LastModified instanceof Date ? head.LastModified.toISOString() : undefined,
      contentType: typeof head.ContentType === "string" ? head.ContentType : undefined,
    }
  } catch (error: unknown) {
    const parsed = formatProbeError(error)
    return { exists: parsed.exists, error: parsed.error }
  }
}

async function probeObjectReadability(input: {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  key: string
}): Promise<{ readable: boolean | null; error?: string }> {
  try {
    const obj = await r2GetObjectStream(
      {
        accountId: input.accountId,
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
      },
      input.bucket,
      input.key
    )

    const body = (obj as { Body?: unknown }).Body
    if (!body) return { readable: false, error: "Object body missing" }

    if (typeof body === "object" && body !== null && "getReader" in body) {
      const reader = (body as ReadableStream<Uint8Array>).getReader()
      await reader.read().catch(() => undefined)
      await reader.cancel().catch(() => undefined)
      return { readable: true }
    }

    if (
      typeof body === "object" &&
      body !== null &&
      "once" in body &&
      typeof (body as { once?: unknown }).once === "function" &&
      "destroy" in body &&
      typeof (body as { destroy?: unknown }).destroy === "function"
    ) {
      await new Promise<void>((resolve, reject) => {
        const stream = body as unknown as {
          once: (event: string, cb: (...args: unknown[]) => void) => void
          destroy: () => void
        }
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          resolve()
        }
        stream.once("data", () => {
          try {
            stream.destroy()
          } catch {
            // ignore
          }
          done()
        })
        stream.once("end", done)
        stream.once("error", (err: unknown) => {
          if (settled) return
          settled = true
          reject(err)
        })
        setTimeout(done, 4_000)
      })
      return { readable: true }
    }

    return { readable: null }
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Read probe failed")
        : "Read probe failed"
    return { readable: false, error: message }
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.min(12, Math.floor(concurrency || 1)))
  const out: R[] = new Array(items.length) as R[]
  let cursor = 0

  const run = async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      out[index] = await worker(items[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
  return out
}

function buildDiagnosis(entry: FailedLogEntry, source: ObjectProbe, destination: ObjectProbe): Diagnosis {
  const message = entry.message.toLowerCase()

  if (source.exists === false) {
    return {
      category: "source_missing",
      reason: "Source object no longer exists or is not readable by source credentials.",
      recommendation: "Confirm the object still exists in source bucket and retry.",
    }
  }

  if (typeof source.error === "string" && /accessdenied|forbidden|invalidaccesskey|signature/i.test(source.error)) {
    return {
      category: "source_access_issue",
      reason: "Source object could not be read due to credentials or permission issues.",
      recommendation: "Check source R2 access key permissions and retry.",
    }
  }

  if (destination.exists === true) {
    if (
      typeof source.size === "number" &&
      typeof destination.size === "number" &&
      source.size !== destination.size
    ) {
      return {
        category: "possible_content_mismatch",
        reason: "Destination object exists but size differs from source.",
        recommendation: "Retry this object with overwrite enabled for this object if possible.",
      }
    }
    if (
      typeof source.etag === "string" &&
      typeof destination.etag === "string" &&
      source.etag !== destination.etag &&
      typeof source.size === "number" &&
      source.size > 0
    ) {
      return {
        category: "possible_content_mismatch",
        reason: "Destination object exists but ETag differs from source.",
        recommendation: "Likely content mismatch. Recopy this object and verify checksum.",
      }
    }
    return {
      category: "destination_exists",
      reason: "Destination object exists, but Cloudflare still reported import retries exhausted.",
      recommendation: "Likely transient/import pipeline issue; rerun with overwrite disabled.",
    }
  }

  if (
    message.includes("retry") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("failed to import")
  ) {
    return {
      category: "transient_or_provider_issue",
      reason: "Cloudflare import pipeline reported retries exhausted without a specific object-level corruption reason.",
      recommendation: "Retry the failed job. If repeated, split large files or contact Cloudflare support with job id and key.",
    }
  }

  return {
    category: "unknown",
    reason: "No precise failure reason is available from current logs.",
    recommendation: "Fetch job logs again and retry failed objects.",
  }
}

function buildDiagnosisFromVerifyDiff(diff: InferredVerifyDiff): Diagnosis {
  if (diff.kind === "missing") {
    return {
      category: "source_missing",
      reason: "Verification found this source object missing in the destination bucket.",
      recommendation: "Retry this object. If it keeps failing, download source and inspect it directly.",
    }
  }
  if (diff.kind === "size_mismatch") {
    return {
      category: "possible_content_mismatch",
      reason: "Verification found the destination object present with a different size.",
      recommendation: "Recopy this object and verify checksum or size again.",
    }
  }
  if (diff.kind === "extra") {
    return {
      category: "destination_exists",
      reason: "Verification found an unexpected destination object not present in source.",
      recommendation: "Inspect destination object and clean it up if it is stale or unrelated.",
    }
  }
  return {
    category: "unknown",
    reason: "Verification identified an object-level inconsistency.",
    recommendation: "Inspect this object manually and rerun verification.",
  }
}

async function ensureCompletedScan(input: {
  scanId?: string
  accountId: string
  bucketName: string
  kind: "source" | "dest"
  migrationId: string
  migrationItemId: string
  prefix?: string | null
  r2: {
    accountId: string
    accessKeyId: string
    secretAccessKey: string
  }
}): Promise<string | null> {
  let scan =
    typeof input.scanId === "string" && input.scanId.trim().length > 0 ? await getBucketScan(input.scanId).catch(() => null) : null

  if (!scan) {
    scan = await ensureBucketScan({
      accountId: input.accountId,
      bucketName: input.bucketName,
      kind: input.kind,
      migrationId: input.migrationId,
      migrationItemId: input.migrationItemId,
      prefix: input.prefix ?? null,
    })
  }

  let loops = 0
  while (scan && scan.status !== "completed" && scan.status !== "failed" && loops < 60) {
    scan = await runBucketScanBatch({
      scanId: scan.id,
      r2: input.r2,
      bucketName: input.bucketName,
      prefix: input.prefix ?? null,
      maxObjects: 2_000,
    })
    loops += 1
  }

  return scan?.id ?? null
}

async function inferDiffsFromLiveBucketLists(input: {
  source: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }
  destination: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }
  prefix?: string | null
  limit?: number
  includeExtra?: boolean
}): Promise<InferredVerifyDiff[]> {
  const [sourceObjects, destinationObjects] = await Promise.all([
    r2ListAllObjects(
      {
        accountId: input.source.accountId,
        accessKeyId: input.source.accessKeyId,
        secretAccessKey: input.source.secretAccessKey,
      },
      input.source.bucket,
      { prefix: input.prefix ?? undefined, maxObjects: 200_000 }
    ),
    r2ListAllObjects(
      {
        accountId: input.destination.accountId,
        accessKeyId: input.destination.accessKeyId,
        secretAccessKey: input.destination.secretAccessKey,
      },
      input.destination.bucket,
      { prefix: input.prefix ?? undefined, maxObjects: 200_000 }
    ),
  ])

  const limit = Math.max(1, Math.min(5_000, input.limit ?? 500))
  const includeExtra = input.includeExtra === true
  const diffs: InferredVerifyDiff[] = []
  const destinationMap = new Map(destinationObjects.map((obj) => [obj.key, obj.size] as const))

  for (const sourceObject of sourceObjects) {
    const destinationSize = destinationMap.get(sourceObject.key)
    if (typeof destinationSize === "undefined") {
      diffs.push({ kind: "missing", key: sourceObject.key, sourceSize: sourceObject.size, destSize: null })
    } else if (destinationSize !== sourceObject.size) {
      diffs.push({
        kind: "size_mismatch",
        key: sourceObject.key,
        sourceSize: sourceObject.size,
        destSize: destinationSize,
      })
    }
    if (diffs.length >= limit) return diffs
  }

  if (!includeExtra || diffs.length >= limit) return diffs

  const sourceSet = new Set(sourceObjects.map((obj) => obj.key))
  for (const destinationObject of destinationObjects) {
    if (!sourceSet.has(destinationObject.key)) {
      diffs.push({ kind: "extra", key: destinationObject.key, sourceSize: null, destSize: destinationObject.size })
    }
    if (diffs.length >= limit) break
  }

  return diffs
}

export async function GET(request: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  try {
    const { id, itemId } = await context.params
    const url = new URL(request.url)
    const limitRaw = Number(url.searchParams.get("limit") ?? "150")
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 150
    const forceRefresh = url.searchParams.get("refresh") === "1"

    const migration = await getMigration(id)
    if (!migration) return NextResponse.json({ error: "Migration not found" }, { status: 404 })

    const items = await listMigrationItems(id)
    const item = items.find((i) => i.id === itemId)
    if (!item) {
      return NextResponse.json(
        {
          ok: true,
          missing: true,
          item: {
            id: itemId,
            sourceBucket: "Unavailable",
            targetBucket: "",
            jobId: null,
            status: null,
          },
          summary: {
            totalFailedEntries: 0,
            detailedFailedEntries: 0,
            cloudflareDetailedEntries: 0,
            fallbackDetailedEntries: 0,
            inferredDetailedEntries: 0,
            missingDetailedEntries: 0,
            sourceMissing: 0,
            sourceAccessIssues: 0,
            destinationExists: 0,
            transientOrProviderIssues: 0,
            unknown: 0,
          },
          failures: [],
        },
        { status: 200 }
      )
    }

    const itemProgress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
    const storedSnapshot = isRecord(itemProgress.failedDiagnosticsSnapshot)
      ? (itemProgress.failedDiagnosticsSnapshot as Record<string, unknown>)
      : null
    const reportedFailedObjects = readReportedFailedObjects(itemProgress)

    if (!forceRefresh) {
      const storedRecords = await listMigrationItemFailureRecords(item.id, limit).catch(() => [])
      const storedSummary = storedSnapshot && isRecord(storedSnapshot.summary) ? (storedSnapshot.summary as Record<string, unknown>) : null

      const storedFailures = storedRecords
        .map((entry) => ({
          key: entry.objectKey,
          message: entry.message,
          at: entry.occurredAtText ?? null,
          rawLog: entry.rawLog ?? null,
          source: isRecord(entry.sourceProbe) ? entry.sourceProbe : {},
          destination: isRecord(entry.destinationProbe) ? entry.destinationProbe : {},
          diagnosis: isRecord(entry.diagnosis) ? entry.diagnosis : {},
          download: isRecord(entry.download) ? entry.download : {},
        }))
        .filter((entry) => entry.key && entry.message)

      const totalFailedEntries =
        storedSummary && typeof storedSummary.totalFailedEntries === "number"
          ? storedSummary.totalFailedEntries
          : Math.max(reportedFailedObjects, storedFailures.length)
      const missingDetailedEntries =
        storedSummary && typeof storedSummary.missingDetailedEntries === "number"
          ? storedSummary.missingDetailedEntries
          : Math.max(0, totalFailedEntries - storedFailures.length)
      const hasRecoverableGap = totalFailedEntries > 0 && (storedFailures.length === 0 || missingDetailedEntries > 0)

      if (!hasRecoverableGap && (storedFailures.length > 0 || totalFailedEntries > 0)) {
        return NextResponse.json(
          {
            ok: true,
            cached: true,
            item: {
              id: item.id,
              sourceBucket: item.sourceBucket,
              targetBucket: item.targetBucket,
              jobId: item.slurperJobId ?? null,
              status: item.slurperStatus ?? null,
            },
            summary: {
              totalFailedEntries,
              detailedFailedEntries:
                storedSummary && typeof storedSummary.detailedFailedEntries === "number"
                  ? storedSummary.detailedFailedEntries
                  : storedFailures.length,
              cloudflareDetailedEntries:
                storedSummary && typeof storedSummary.cloudflareDetailedEntries === "number"
                  ? storedSummary.cloudflareDetailedEntries
                  : storedFailures.length,
              fallbackDetailedEntries:
                storedSummary && typeof storedSummary.fallbackDetailedEntries === "number"
                  ? storedSummary.fallbackDetailedEntries
                  : 0,
              inferredDetailedEntries:
                storedSummary && typeof storedSummary.inferredDetailedEntries === "number"
                  ? storedSummary.inferredDetailedEntries
                  : 0,
              missingDetailedEntries:
                missingDetailedEntries,
              sourceMissing:
                storedSummary && typeof storedSummary.sourceMissing === "number"
                  ? storedSummary.sourceMissing
                  : storedFailures.filter((d) => isRecord(d.diagnosis) && d.diagnosis.category === "source_missing").length,
              sourceAccessIssues:
                storedSummary && typeof storedSummary.sourceAccessIssues === "number"
                  ? storedSummary.sourceAccessIssues
                  : storedFailures.filter((d) => isRecord(d.diagnosis) && d.diagnosis.category === "source_access_issue").length,
              destinationExists:
                storedSummary && typeof storedSummary.destinationExists === "number"
                  ? storedSummary.destinationExists
                  : storedFailures.filter((d) => isRecord(d.diagnosis) && d.diagnosis.category === "destination_exists").length,
              transientOrProviderIssues:
                storedSummary && typeof storedSummary.transientOrProviderIssues === "number"
                  ? storedSummary.transientOrProviderIssues
                  : storedFailures.filter((d) => isRecord(d.diagnosis) && d.diagnosis.category === "transient_or_provider_issue").length,
              unknown:
                storedSummary && typeof storedSummary.unknown === "number"
                  ? storedSummary.unknown
                  : storedFailures.filter((d) => isRecord(d.diagnosis) && d.diagnosis.category === "unknown").length,
            },
            failures: storedFailures,
          },
          { status: 200 }
        )
      }
    }

    const accounts = await getAllAccounts()
    const source = accounts.find((a) => a.id === migration.sourceAccountId)
    const target = accounts.find((a) => a.id === migration.targetAccountId)
    if (!source || !target) return NextResponse.json({ error: "Source/target account not found" }, { status: 400 })
    if (!source.cloudflareAccountId || !target.cloudflareAccountId) {
      return NextResponse.json({ error: "Cloudflare account ids are not synced" }, { status: 400 })
    }

    const logsPayloadStored: unknown = isRecord(item.progress) ? (item.progress as Record<string, unknown>).logs : undefined
    const logsPayloads: unknown[] = []
    if (typeof logsPayloadStored !== "undefined") logsPayloads.push(logsPayloadStored)
    if (item.slurperJobId) {
      const remotePages = await collectJobLogs({
        accountId: target.cloudflareAccountId,
        apiToken: target.apiToken,
        jobId: item.slurperJobId,
      })
      logsPayloads.push(...remotePages)
    }

    const cloudflareFailedEntries = extractFailedEntries(logsPayloads)
      .map((entry) => ({ ...entry, evidence: "cloudflare_log" as const }))
      .slice(0, limit)
    const progressFallbackEntries = readProgressFallbackEntries(itemProgress, limit)
    const needRepairJobFallback =
      cloudflareFailedEntries.length + progressFallbackEntries.length < Math.min(limit, Math.max(reportedFailedObjects, 1))
    const repairJobFallbackEntries = needRepairJobFallback
      ? readRepairJobFallbackEntries(await listRepairJobsByMigration(id, 10).catch(() => []), item.id, limit)
      : []
    const failedEntries = dedupeFailedEntries(
      [...cloudflareFailedEntries, ...progressFallbackEntries, ...repairJobFallbackEntries],
      limit
    )
    const downloadBase = `/api/migrations/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/failed-object`

    const diagnostics = await mapWithConcurrency(
      failedEntries,
      6,
      async (entry) => {
        const [sourceProbe, destinationProbe] = await Promise.all([
          probeObject({
            accountId: source.cloudflareAccountId!,
            accessKeyId: source.r2AccessKeyId,
            secretAccessKey: source.r2SecretAccessKey,
            bucket: item.sourceBucket,
            key: entry.key,
          }),
          probeObject({
            accountId: target.cloudflareAccountId!,
            accessKeyId: target.r2AccessKeyId,
            secretAccessKey: target.r2SecretAccessKey,
            bucket: item.targetBucket,
            key: entry.key,
          }),
        ])
        const sourceReadability =
          sourceProbe.exists === true
            ? await probeObjectReadability({
                accountId: source.cloudflareAccountId!,
                accessKeyId: source.r2AccessKeyId,
                secretAccessKey: source.r2SecretAccessKey,
                bucket: item.sourceBucket,
                key: entry.key,
              })
            : { readable: null as boolean | null }

        const mergedSource: ObjectProbe = {
          ...sourceProbe,
          readable: sourceReadability.readable,
          ...(typeof sourceReadability.error === "string" ? { error: sourceReadability.error } : {}),
        }

        return {
          key: entry.key,
          message: entry.message,
          at: entry.at ?? null,
          rawLog: entry.raw ?? null,
          source: mergedSource,
          destination: destinationProbe,
          diagnosis: buildDiagnosis(entry, mergedSource, destinationProbe),
          download: {
            source: `${downloadBase}?side=source&key=${encodeURIComponent(entry.key)}`,
            destination:
              destinationProbe.exists === true
                ? `${downloadBase}?side=destination&key=${encodeURIComponent(entry.key)}`
                : null,
          },
        }
      }
    )

    const diagnosticsByKey = new Set(diagnostics.map((entry) => entry.key))
    const cloudflareDetailedEntries = failedEntries.filter((entry) => entry.evidence === "cloudflare_log").length
    const fallbackDetailedEntries = failedEntries.filter((entry) => entry.evidence !== "cloudflare_log").length
    const progress = itemProgress
    let inferredDiagnostics: Array<{
      key: string
      message: string
      at: string | null
      rawLog: unknown
      source: ObjectProbe
      destination: ObjectProbe
      diagnosis: Diagnosis
      download: { source: string; destination: string | null }
      inferredFrom: string
    }> = []

    if (reportedFailedObjects > diagnostics.length) {
      const verifyDiffs = await listVerifyDiffsForItem({
        migrationItemId: item.id,
        limit: Math.max(limit, reportedFailedObjects),
      }).catch(() => [])
      let candidateDiffs = verifyDiffs.filter((diff) => diff.key && !diagnosticsByKey.has(diff.key))

      if (candidateDiffs.length < reportedFailedObjects - diagnostics.length) {
        const pathPrefix =
          typeof migration.options?.pathPrefix === "string" && migration.options.pathPrefix.trim().length > 0
            ? migration.options.pathPrefix
            : null

        const sourceScanId = await ensureCompletedScan({
          scanId: typeof progress.sourceScanId === "string" ? progress.sourceScanId : undefined,
          accountId: source.id,
          bucketName: item.sourceBucket,
          kind: "source",
          migrationId: id,
          migrationItemId: item.id,
          prefix: pathPrefix,
          r2: {
            accountId: source.cloudflareAccountId!,
            accessKeyId: source.r2AccessKeyId,
            secretAccessKey: source.r2SecretAccessKey,
          },
        }).catch(() => null)

        const destScanId = await ensureCompletedScan({
          scanId: typeof progress.destScanId === "string" ? progress.destScanId : undefined,
          accountId: target.id,
          bucketName: item.targetBucket,
          kind: "dest",
          migrationId: id,
          migrationItemId: item.id,
          prefix: pathPrefix,
          r2: {
            accountId: target.cloudflareAccountId!,
            accessKeyId: target.r2AccessKeyId,
            secretAccessKey: target.r2SecretAccessKey,
          },
        }).catch(() => null)

        if (sourceScanId && destScanId) {
          const inferredDiffsFromScans = await inferVerifyDiffsFromScans({
            sourceScanId,
            destScanId,
            limit: Math.max(limit, reportedFailedObjects),
            includeExtra: migration.options?.verifyStrictDestination === true,
          }).catch(() => [])

          if (inferredDiffsFromScans.length > 0) {
            const mergedByKey = new Map<string, InferredVerifyDiff>()
            for (const diff of candidateDiffs) mergedByKey.set(diff.key, diff)
            for (const diff of inferredDiffsFromScans) {
              if (!diff.key || diagnosticsByKey.has(diff.key) || mergedByKey.has(diff.key)) continue
              mergedByKey.set(diff.key, diff)
            }
            candidateDiffs = Array.from(mergedByKey.values())
          }
        }

        if (candidateDiffs.length < reportedFailedObjects - diagnostics.length) {
          const inferredDiffsFromLiveLists = await inferDiffsFromLiveBucketLists({
            source: {
              accountId: source.cloudflareAccountId!,
              accessKeyId: source.r2AccessKeyId,
              secretAccessKey: source.r2SecretAccessKey,
              bucket: item.sourceBucket,
            },
            destination: {
              accountId: target.cloudflareAccountId!,
              accessKeyId: target.r2AccessKeyId,
              secretAccessKey: target.r2SecretAccessKey,
              bucket: item.targetBucket,
            },
            prefix: pathPrefix,
            limit: Math.max(limit, reportedFailedObjects),
            includeExtra: migration.options?.verifyStrictDestination === true,
          }).catch(() => [])

          if (inferredDiffsFromLiveLists.length > 0) {
            const mergedByKey = new Map<string, InferredVerifyDiff>()
            for (const diff of candidateDiffs) mergedByKey.set(diff.key, diff)
            for (const diff of inferredDiffsFromLiveLists) {
              if (!diff.key || diagnosticsByKey.has(diff.key) || mergedByKey.has(diff.key)) continue
              mergedByKey.set(diff.key, diff)
            }
            candidateDiffs = Array.from(mergedByKey.values())
          }
        }
      }

      inferredDiagnostics = await mapWithConcurrency(
        candidateDiffs.slice(0, Math.max(0, limit - diagnostics.length)),
        6,
        async (diff) => {
          const [sourceProbe, destinationProbe] = await Promise.all([
            probeObject({
              accountId: source.cloudflareAccountId!,
              accessKeyId: source.r2AccessKeyId,
              secretAccessKey: source.r2SecretAccessKey,
              bucket: item.sourceBucket,
              key: diff.key,
            }),
            probeObject({
              accountId: target.cloudflareAccountId!,
              accessKeyId: target.r2AccessKeyId,
              secretAccessKey: target.r2SecretAccessKey,
              bucket: item.targetBucket,
              key: diff.key,
            }),
          ])

          return {
            key: diff.key,
            message:
              diff.kind === "missing"
                ? "Inferred failure from source/destination scan: object missing in destination."
                : diff.kind === "size_mismatch"
                  ? "Inferred failure from source/destination scan: object size mismatch."
                  : "Inferred failure from source/destination scan.",
            at: null,
            rawLog: { source: "scan_inference", ...diff },
            source: sourceProbe,
            destination: destinationProbe,
            diagnosis: buildDiagnosisFromVerifyDiff(diff),
            download: {
              source: `${downloadBase}?side=source&key=${encodeURIComponent(diff.key)}`,
              destination:
                destinationProbe.exists === true
                  ? `${downloadBase}?side=destination&key=${encodeURIComponent(diff.key)}`
                  : null,
            },
            inferredFrom: "verification",
          }
        }
      )
    }

    const combinedDiagnostics = [...diagnostics, ...inferredDiagnostics]

    const summary = {
      totalFailedEntries: Math.max(reportedFailedObjects, combinedDiagnostics.length),
      detailedFailedEntries: combinedDiagnostics.length,
      cloudflareDetailedEntries,
      fallbackDetailedEntries,
      inferredDetailedEntries: inferredDiagnostics.length,
      missingDetailedEntries: Math.max(0, reportedFailedObjects - combinedDiagnostics.length),
      sourceMissing: combinedDiagnostics.filter((d) => d.diagnosis.category === "source_missing").length,
      sourceAccessIssues: combinedDiagnostics.filter((d) => d.diagnosis.category === "source_access_issue").length,
      destinationExists: combinedDiagnostics.filter((d) => d.diagnosis.category === "destination_exists").length,
      transientOrProviderIssues: combinedDiagnostics.filter((d) => d.diagnosis.category === "transient_or_provider_issue").length,
      unknown: combinedDiagnostics.filter((d) => d.diagnosis.category === "unknown").length,
    }

    const fetchedAt = new Date().toISOString()

    await replaceMigrationItemFailureRecords(
      item.id,
      combinedDiagnostics.map((entry) => ({
        migrationItemId: item.id,
        objectKey: entry.key,
        message: entry.message,
        occurredAtText: entry.at ?? "",
        rawLog: entry.rawLog ?? null,
        sourceProbe: entry.source,
        destinationProbe: entry.destination,
        diagnosis: entry.diagnosis,
        download: entry.download ?? null,
        fetchedAt,
      }))
    )

    await updateMigrationItem(item.id, {
      progress: {
        failedDiagnosticsSnapshot: {
          fetchedAt,
          reportedFailedObjects,
          summary,
          rawLogPayloads: logsPayloads,
          parsedFailedEntries: failedEntries,
          diagnostics: combinedDiagnostics,
        },
      },
      lastProgressAt: fetchedAt,
    })

    return NextResponse.json(
      {
        ok: true,
        item: {
          id: item.id,
          sourceBucket: item.sourceBucket,
          targetBucket: item.targetBucket,
          jobId: item.slurperJobId ?? null,
          status: item.slurperStatus ?? null,
        },
        summary,
        failures: combinedDiagnostics,
      },
      { status: 200 }
    )
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unable to load failed object diagnostics")
        : "Unable to load failed object diagnostics"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
