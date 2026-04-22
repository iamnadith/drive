import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import {
  slurperConnectivityPrecheckSource,
  slurperConnectivityPrecheckTarget,
  slurperCreateJob,
  slurperGetActiveJobCount,
  slurperExtractCreatedJobId,
  slurperFindJobIdForBuckets,
  slurperGetJobProgress,
  slurperListJobLogs,
  type SlurperSource,
} from "@/lib/cloudflare-r2-super-slurper"
import { r2CreateBucketViaApi } from "@/lib/cloudflare-r2-buckets"
import { cloudflareFetchJson, CloudflareApiError } from "@/lib/cloudflare-api"
import { r2ListOneObject } from "@/lib/r2-s3"
import { getBucketStatsMap } from "@/lib/bucket-stats-store"
import {
  createInitialBucketVerifyState,
  readBucketVerifyState,
} from "@/lib/bucket-verifier"
import {
  ensureBucketScan,
  runBucketScanBatch,
  getBucketScan,
  markBucketScanFailed,
  computeAndStoreVerifyDiffs,
} from "@/lib/bucket-scan-store"
import {
  getMigration,
  listMigrationItems,
  updateMigration,
  updateMigrationItem,
  claimMigrationItemJobCreation,
} from "@/lib/migrations-store"
import { syncMigrationLiveState } from "@/lib/migration-live-state"
import { readLiveBucketState, shouldUseLiveBucketState } from "@/lib/migration-bucket-state"

export const runtime = "nodejs"

const MAX_CLOUDFLARE_CONCURRENT_JOBS = 3

function isRecentlySynced(lastSyncedAt: string | undefined, withinMs = 5_000): boolean {
  if (!lastSyncedAt) return false
  const t = Date.parse(lastSyncedAt)
  if (!Number.isFinite(t)) return false
  return Date.now() - t < withinMs
}

function formatCloudflareError(error: unknown, fallback: string): string {
  if (error instanceof CloudflareApiError) {
    const status = typeof error.status === "number" ? ` (HTTP ${error.status})` : ""
    const raw = typeof error.payloadText === "string" ? error.payloadText.trim() : ""
    const snippet = raw ? ` - ${raw.slice(0, 280)}` : ""
    return `${error.message}${status}${snippet}`
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message
  }
  return fallback
}

function isRateLimited(error: unknown): error is CloudflareApiError {
  return error instanceof CloudflareApiError && error.status === 429
}

function isJobLimitReached(error: unknown): error is CloudflareApiError {
  return error instanceof CloudflareApiError && error.status === 409
}

function isCloudflareTransientError(error: unknown): error is CloudflareApiError {
  return (
    error instanceof CloudflareApiError &&
    typeof error.status === "number" &&
    (error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504)
  )
}

function isTransientNetworkError(error: unknown): boolean {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "").toLowerCase()
      : String(error ?? "").toLowerCase()

  return (
    message.includes("fetch failed") ||
    message.includes("failed to fetch") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("eai_again") ||
    message.includes("socket hang up") ||
    message.includes("network")
  )
}

function normalizeSlurperStatus(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase()
}

function isTerminalSlurperStatus(value: string | undefined): boolean {
  const s = normalizeSlurperStatus(value)
  return (
    s === "completed" ||
    s === "complete" ||
    s === "finished" ||
    s === "success" ||
    s === "succeeded" ||
    s === "aborted" ||
    s === "canceled" ||
    s === "cancelled" ||
    s === "failed" ||
    s === "error" ||
    s === "copy_completed" ||
    s === "copy_failed" ||
    s === "copy_aborted"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readLiveStatus(item: { progress?: unknown; slurperJobId?: string | null }): string | undefined {
  const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
  const live = readLiveBucketState(progress)
  return shouldUseLiveBucketState({ slurperJobId: item.slurperJobId ?? undefined }, live) && typeof live?.status === "string" ? live.status : undefined
}

function readMergedItemStatus(item: { progress?: unknown; slurperJobId?: string | null; slurperStatus?: string | null }): string {
  const liveStatus = readLiveStatus(item)
  if (liveStatus) return normalizeSlurperStatus(liveStatus)

  const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
  const stage = typeof progress.stage === "string" ? progress.stage : ""
  const sourceScanStatus = typeof progress.sourceScanStatus === "string" ? progress.sourceScanStatus : ""
  if (
    !item.slurperJobId &&
    (stage === "scan_seeded" ||
      ((stage === "scanning_source" || sourceScanStatus === "pending" || sourceScanStatus === "running") &&
        sourceScanStatus !== "completed" &&
        sourceScanStatus !== "failed"))
  ) {
    return "scanning"
  }
  if (!item.slurperJobId && stage === "scan_failed") return "failed"

  const slurperStatus =
    typeof item.slurperStatus === "string" && item.slurperStatus.trim()
      ? item.slurperStatus
      : typeof progress.slurperStatus === "string" && progress.slurperStatus.trim()
        ? String(progress.slurperStatus)
        : ""
  const normalizedSlurperStatus = normalizeSlurperStatus(slurperStatus)
  if (normalizedSlurperStatus && normalizedSlurperStatus !== "completed" && normalizedSlurperStatus !== "copy_completed") {
    return normalizedSlurperStatus
  }

  const verify = isRecord(progress.verify) ? (progress.verify as Record<string, unknown>) : null
  const verifyStatus = typeof verify?.status === "string" ? normalizeSlurperStatus(verify.status) : ""
  if (verifyStatus === "pending" || verifyStatus === "running") return "verifying"
  if (verifyStatus === "error") return "verification_failed"
  if (verifyStatus === "ok" && typeof verify?.note === "string" && verify.note === "no_source_objects") return "completed"

  return normalizedSlurperStatus
}

function shouldPollSlurperProgress(item: { progress?: unknown; slurperJobId?: string | null; slurperStatus?: string | null }): boolean {
  if (!item.slurperJobId) return false
  const mergedStatus = readMergedItemStatus(item)
  if (!mergedStatus) return true
  return !isTerminalSlurperStatus(mergedStatus) && !isFailedLikeMergedStatus(mergedStatus)
}

function isCompletedLikeMergedStatus(status: string): boolean {
  return isTerminalSlurperStatus(status) && !isAbortedLikeMergedStatus(status) && !isFailedLikeMergedStatus(status)
}

function isAbortedLikeMergedStatus(status: string): boolean {
  return status === "aborted" || status === "canceled" || status === "cancelled" || status === "copy_aborted"
}

function isFailedLikeMergedStatus(status: string): boolean {
  return (
    status === "verification_failed" ||
    status === "precheck_failed" ||
    status === "bucket_create_failed" ||
    status === "job_create_failed" ||
    status.endsWith("_failed") ||
    status.includes("failed") ||
    status.includes("error") ||
    status === "copy_failed"
  )
}

function getNumberFromRecord(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = rec[key]
    if (typeof v === "number" && Number.isFinite(v)) return v
  }
  return undefined
}

function getStringFromRecord(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) return v
  }
  return undefined
}

async function promisePool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  const limit = Math.max(1, Math.min(10, Math.floor(concurrency || 1)))
  let index = 0
  const run = async () => {
    while (true) {
      const current = index++
      if (current >= items.length) return
      await worker(items[current])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
}

async function collectLiveJobLogs(input: {
  accountId: string
  apiToken: string
  jobId: string
  maxPages?: number
}): Promise<unknown[]> {
  const maxPages = Math.max(1, Math.min(6, Math.floor(input.maxPages ?? 3)))
  const pages: unknown[] = []
  for (let page = 1; page <= maxPages; page += 1) {
    const logs = await slurperListJobLogs({
      accountId: input.accountId,
      apiToken: input.apiToken,
      jobId: input.jobId,
      page,
      perPage: 200,
    }).catch(() => null)
    if (!logs) break
    pages.push(logs)
  }
  return pages
}

function mapToJurisdiction(value: unknown): "default" | "eu" | "fedramp" | undefined {
  if (value === "default" || value === "eu" || value === "fedramp") return value
  return undefined
}

function buildSourceSpec(input: {
  bucket: string
  sourceAccountId: string
  accessKeyId: string
  secretAccessKey: string
  pathPrefix?: string | null
}): SlurperSource {
  return {
    vendor: "s3",
    bucket: input.bucket,
    secret: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    // Cloudflare's Super Slurper expects the bucket in the endpoint for R2 S3 sources.
    endpoint: `https://${input.sourceAccountId}.r2.cloudflarestorage.com/${encodeURIComponent(input.bucket)}`,
    ...(typeof input.pathPrefix !== "undefined" ? { pathPrefix: input.pathPrefix } : {}),
  }
}

function buildSourceSpecR2Fallback(input: {
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  jurisdiction?: "default" | "eu" | "fedramp"
  pathPrefix?: string | null
}): SlurperSource {
  return {
    vendor: "r2",
    bucket: input.bucket,
    secret: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    jurisdiction: input.jurisdiction,
    ...(typeof input.pathPrefix !== "undefined" ? { pathPrefix: input.pathPrefix } : {}),
  }
}

function formatAwsError(error: unknown): string {
  if (typeof error !== "object" || error === null) return "Unknown S3 error"
  const maybe = error as { name?: unknown; message?: unknown; Code?: unknown; code?: unknown }
  const code = typeof maybe.Code === "string" ? maybe.Code : typeof maybe.code === "string" ? maybe.code : ""
  const name = typeof maybe.name === "string" ? maybe.name : ""
  const message = typeof maybe.message === "string" ? maybe.message : ""
  const parts = [code || name, message].filter((p) => p && String(p).trim())
  return parts.length ? parts.join(": ") : "Unknown S3 error"
}

async function checkDestinationSlurperPermissions(input: {
  accountId: string
  apiToken: string
}): Promise<string | null> {
  try {
    await cloudflareFetchJson(
      {
        apiToken: input.apiToken,
        path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/jobs`,
      },
      { retries: 0, timeoutMs: 10_000 }
    )
    return null
  } catch (error: unknown) {
    if (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403)) {
      return `Destination API token cannot access Super Slurper endpoints (HTTP ${error.status}). Ensure the token has R2 permissions (including Super Slurper).`
    }
    return null
  }
}

async function ensureTargetBucketExists(input: {
  targetCloudflareAccountId: string
  targetApiToken: string
  bucketName: string
  jurisdiction?: "default" | "eu" | "fedramp"
  storageClass?: "Standard" | "InfrequentAccess"
}) {
  try {
    await r2CreateBucketViaApi({
      accountId: input.targetCloudflareAccountId,
      apiToken: input.targetApiToken,
      name: input.bucketName,
      jurisdiction: input.jurisdiction,
      storageClass: input.storageClass,
    })
  } catch (error: unknown) {
    if (error instanceof CloudflareApiError) {
      const text = (error.payloadText ?? "").toLowerCase()
      const msg = (error.message ?? "").toLowerCase()
      const alreadyExists =
        msg.includes("already") ||
        msg.includes("exists") ||
        text.includes("already") ||
        text.includes("exists")
      if (alreadyExists) return
    }
    throw error
  }
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const migration = await getMigration(id)
    if (!migration) return NextResponse.json({ error: "Migration not found" }, { status: 404 })

    // Terminal migrations should not trigger Cloudflare polling (progress/log fetches) or job creation.
    // But we still reconcile stale terminal states from item-level truth.
    if (migration.status === "completed" || migration.status === "failed" || migration.status === "canceled") {
      const items = await listMigrationItems(id)
      if (migration.status === "completed") {
        const verifyEnabled = migration.options?.verifyAfterCopy !== false
        const isSuccessStatus = (s: string | undefined) => {
          const status = String(s ?? "").toLowerCase()
          return (
            status === "completed" ||
            status === "copy_completed" ||
            status === "complete" ||
            status === "finished" ||
            status === "success" ||
            status === "succeeded"
          )
        }
        const failedLike = (s: string) =>
          s.includes("failed") || s.includes("error") || s.endsWith("_failed") || s === "copy_failed"

        const anySlurperFailure = items.some((i) => failedLike(String(i.slurperStatus ?? "").toLowerCase()))
        const anyAborted = items.some((i) => {
          const s = String(i.slurperStatus ?? "").toLowerCase()
          return s === "aborted" || s === "canceled" || s === "cancelled" || s === "copy_aborted"
        })
        const anyVerifyFailure =
          verifyEnabled &&
          items.some((i) => isSuccessStatus(i.slurperStatus) && readBucketVerifyState(i.progress)?.status === "error")

        if (anySlurperFailure) {
          await updateMigration(id, {
            status: "failed",
            syncStatus: "error",
            syncMessage: "One or more buckets failed",
            completedAt: new Date().toISOString(),
            lastSyncedAt: new Date().toISOString(),
          })
        } else if (anyAborted) {
          await updateMigration(id, {
            status: "canceled",
            syncStatus: "ok",
            syncMessage: "Migration aborted",
            completedAt: new Date().toISOString(),
            lastSyncedAt: new Date().toISOString(),
          })
        } else if (anyVerifyFailure) {
          await updateMigration(id, {
            status: "failed",
            syncStatus: "error",
            syncMessage: "Verification failed for one or more buckets",
            completedAt: new Date().toISOString(),
            lastSyncedAt: new Date().toISOString(),
          })
        }
      }

      const refreshed = await getMigration(id)
      return NextResponse.json({ migration: refreshed ?? migration, items, skipped: "terminal" }, { status: 200 })
    }

    // Best-effort guard against overlapping sync calls (UI polling + manual "Sync now").
    if (migration.syncStatus === "syncing" && isRecentlySynced(migration.lastSyncedAt, 1_500)) {
      const items = await listMigrationItems(id)
      return NextResponse.json({ migration, items }, { status: 200 })
    }

    await updateMigration(id, {
      syncStatus: "syncing",
      syncMessage: "Refreshing job progress",
      lastSyncedAt: new Date().toISOString(),
    })

    const accounts = await getAllAccounts()
    const source = accounts.find((a) => a.id === migration.sourceAccountId)
    const target = accounts.find((a) => a.id === migration.targetAccountId)
    if (!source) return NextResponse.json({ error: "Source account not found" }, { status: 400 })
    if (!target) return NextResponse.json({ error: "Target account not found" }, { status: 400 })

    if (!source.cloudflareAccountId) {
      return NextResponse.json({ error: "Source Cloudflare account is not synced" }, { status: 400 })
    }
    if (!target.cloudflareAccountId) {
      return NextResponse.json({ error: "Target Cloudflare account is not synced" }, { status: 400 })
    }
    if (!source.r2AccessKeyId || !source.r2SecretAccessKey) {
      return NextResponse.json({ error: "Source account missing R2 access keys" }, { status: 400 })
    }
    if (!target.r2AccessKeyId || !target.r2SecretAccessKey) {
      return NextResponse.json({ error: "Target account missing R2 access keys" }, { status: 400 })
    }

    let items = await listMigrationItems(id)

    const pathPrefix = migration.options.pathPrefix

    // Populate source totals from cached bucket stats when available.
    const statsMap = await getBucketStatsMap(source.id).catch(() => new Map())
    const needsTotals = items.filter((i) => (i.sourceObjects ?? 0) === 0 || (i.sourceBytes ?? 0) === 0)
    if (needsTotals.length > 0) {
      await promisePool(needsTotals, 3, async (item) => {
        const stats = statsMap.get(item.sourceBucket)
        if (!stats || stats.status !== "completed") return
        await updateMigrationItem(item.id, {
          ...(typeof stats.objects === "number" && stats.objects >= 0 ? { sourceObjects: stats.objects } : {}),
          ...(typeof stats.bytes === "number" && stats.bytes >= 0 ? { sourceBytes: stats.bytes } : {}),
          progress: { ...item.progress, statsFromBucketStats: true },
          lastProgressAt: new Date().toISOString(),
        })
      })
      items = await listMigrationItems(id)
    }

    // Phase 0: build authoritative per-bucket inventories for source buckets (file list + accurate counts).
    // This is persisted in Supabase and used later for verification and accurate UI totals.
    const scanPrefix = typeof pathPrefix === "string" && pathPrefix.trim().length > 0 ? pathPrefix : null

    const ensureSourceScanId = async (item: (typeof items)[number]): Promise<string> => {
      const p = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
      const existing = typeof p.sourceScanId === "string" && p.sourceScanId.trim().length > 0 ? p.sourceScanId : ""
      if (existing) return existing
      const scan = await ensureBucketScan({
        accountId: source.id,
        bucketName: item.sourceBucket,
        kind: "source",
        migrationId: id,
        migrationItemId: item.id,
        prefix: scanPrefix,
      })
      await updateMigrationItem(item.id, {
        progress: { ...item.progress, stage: "scan_seeded", sourceScanId: scan.id, error: null, lastError: null },
        lastProgressAt: new Date().toISOString(),
      })
      return scan.id
    }

    // Seed scan ids if missing.
    const seedNeeded = items.filter((i) => {
      const p = isRecord(i.progress) ? (i.progress as Record<string, unknown>) : {}
      return !(typeof p.sourceScanId === "string" && p.sourceScanId.trim().length > 0)
    })
    if (seedNeeded.length > 0) {
      await promisePool(seedNeeded.slice(0, 5), 2, async (item) => {
        await ensureSourceScanId(item)
      })
      items = await listMigrationItems(id)
    }

    // Run a small scan batch each sync until all source scans are complete.
    const scanTargets: Array<{ item: (typeof items)[number]; scanId: string; scan: Awaited<ReturnType<typeof getBucketScan>> }> = []
    for (const item of items) {
      const p = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
      const scanId = typeof p.sourceScanId === "string" ? p.sourceScanId : ""
      if (!scanId) continue
      const scan = await getBucketScan(scanId).catch(() => null)
      scanTargets.push({ item, scanId, scan })
    }

    const incompleteSourceScans = scanTargets.filter((t) => !t.scan || (t.scan.status !== "completed" && t.scan.status !== "failed"))
    if (incompleteSourceScans.length > 0) {
      await updateMigration(id, {
        status: migration.status === "draft" ? "running" : migration.status,
        syncStatus: "syncing",
        syncMessage: `Scanning source buckets (${incompleteSourceScans.length} remaining)`,
        lastSyncedAt: new Date().toISOString(),
      })

      // Scan at most 1 bucket per tick to keep latency low.
      const targetScan = incompleteSourceScans[0]!
      try {
        const scan = await runBucketScanBatch({
          scanId: targetScan.scanId,
          r2: {
            accountId: source.cloudflareAccountId!,
            accessKeyId: source.r2AccessKeyId!,
            secretAccessKey: source.r2SecretAccessKey!,
          },
          bucketName: targetScan.item.sourceBucket,
          prefix: scanPrefix,
          maxObjects: 2_000,
        })

        await updateMigrationItem(targetScan.item.id, {
          sourceObjects: scan.objects,
          sourceBytes: scan.bytes,
          progress: {
            ...targetScan.item.progress,
            stage: "scanning_source",
            sourceScanId: scan.id,
            sourceScanStatus: scan.status,
            error: null,
            lastError: null,
          },
          lastProgressAt: new Date().toISOString(),
        })
      } catch (e: unknown) {
        const message =
          typeof e === "object" && e !== null && "message" in e
            ? String((e as { message?: unknown }).message ?? "Source scan failed")
            : "Source scan failed"
        if (isTransientNetworkError(e)) {
          await updateMigrationItem(targetScan.item.id, {
            progress: {
              ...targetScan.item.progress,
              stage: "scanning_source_retry",
              error: null,
              lastError: message,
            },
            lastProgressAt: new Date().toISOString(),
          })
        } else {
          await markBucketScanFailed({ scanId: targetScan.scanId, error: message })
          await updateMigrationItem(targetScan.item.id, {
            progress: { ...targetScan.item.progress, stage: "scan_failed", error: message },
            lastProgressAt: new Date().toISOString(),
          })
        }
      }

      // Return early; scanning must finish before job creation to ensure accurate totals.
      return NextResponse.json({ migration: await getMigration(id), items: await listMigrationItems(id) }, { status: 200 })
    }

    // Refresh progress for any created jobs.
    await promisePool(
      items.filter((i) => shouldPollSlurperProgress(i)),
      3,
      async (item) => {
        if (!item.slurperJobId) return
        try {
          const progress = await slurperGetJobProgress({
            accountId: target.cloudflareAccountId!,
            apiToken: target.apiToken,
            jobId: item.slurperJobId,
          })

          const resultRec = isRecord(progress?.result) ? (progress.result as Record<string, unknown>) : null
          const topRec = isRecord(progress) ? (progress as Record<string, unknown>) : null

          const status =
            (resultRec ? getStringFromRecord(resultRec, ["status", "state"]) : undefined) ??
            (topRec ? getStringFromRecord(topRec, ["status", "state"]) : undefined)

          const normalized = {
            status,
            objects:
              (resultRec ? getNumberFromRecord(resultRec, ["objects", "totalObjects", "objectCount", "total_objects", "total"]) : undefined) ??
              (topRec ? getNumberFromRecord(topRec, ["objects", "totalObjects", "objectCount", "total_objects", "total"]) : undefined),
            transferredObjects:
              (resultRec ? getNumberFromRecord(resultRec, ["transferredObjects", "transferred", "transferred_objects"]) : undefined) ??
              (topRec ? getNumberFromRecord(topRec, ["transferredObjects", "transferred", "transferred_objects"]) : undefined),
            skippedObjects:
              (resultRec ? getNumberFromRecord(resultRec, ["skippedObjects", "skipped", "skipped_objects"]) : undefined) ??
              (topRec ? getNumberFromRecord(topRec, ["skippedObjects", "skipped", "skipped_objects"]) : undefined),
            failedObjects:
              (resultRec ? getNumberFromRecord(resultRec, ["failedObjects", "failed", "failed_objects"]) : undefined) ??
              (topRec ? getNumberFromRecord(topRec, ["failedObjects", "failed", "failed_objects"]) : undefined),
          }

          const currentStatus = item.slurperStatus
          const nextStatus = normalized.status ?? currentStatus
          const effectiveStatus =
            isTerminalSlurperStatus(currentStatus) && !isTerminalSlurperStatus(normalized.status)
              ? currentStatus
              : nextStatus

          const prevCumulative = isRecord(item.progress?.slurperCumulative)
            ? (item.progress.slurperCumulative as Record<string, unknown>)
            : {}
          const prevTransferred =
            typeof prevCumulative.transferredObjects === "number" ? prevCumulative.transferredObjects : 0
          const prevSkipped = typeof prevCumulative.skippedObjects === "number" ? prevCumulative.skippedObjects : 0
          const prevFailed = typeof prevCumulative.failedObjects === "number" ? prevCumulative.failedObjects : 0
          const prevProcessed =
            typeof prevCumulative.processedObjects === "number"
              ? prevCumulative.processedObjects
              : prevTransferred + prevSkipped + prevFailed

          const nextTransferred =
            typeof normalized.transferredObjects === "number" ? normalized.transferredObjects : 0
          const nextSkipped = typeof normalized.skippedObjects === "number" ? normalized.skippedObjects : 0
          const nextFailed = typeof normalized.failedObjects === "number" ? normalized.failedObjects : 0
          const progressRec = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
          const rerunNoOverwrite = progressRec.rerunNoOverwrite === true
          const rerunBaselineTransferredRaw =
            typeof progressRec.rerunBaselineTransferred === "number" && Number.isFinite(progressRec.rerunBaselineTransferred)
              ? progressRec.rerunBaselineTransferred
              : prevTransferred
          const rerunBaselineTransferred = Math.max(0, Math.floor(rerunBaselineTransferredRaw))

          const effectiveTransferred = rerunNoOverwrite
            ? Math.max(rerunBaselineTransferred, rerunBaselineTransferred + nextTransferred)
            : nextTransferred
          const effectiveSkipped = rerunNoOverwrite
            ? Math.max(0, nextSkipped - rerunBaselineTransferred)
            : nextSkipped
          const effectiveFailed = nextFailed
          const nextProcessed = effectiveTransferred + effectiveSkipped + effectiveFailed

          const bestObjectsFromSource =
            typeof item.sourceObjects === "number" && Number.isFinite(item.sourceObjects)
              ? item.sourceObjects
              : 0
          const cumulativeObjects = Math.max(
            typeof prevCumulative.objects === "number" ? prevCumulative.objects : 0,
            typeof normalized.objects === "number" ? normalized.objects : 0,
            bestObjectsFromSource
          )

          const slurperCumulative = {
            objects: cumulativeObjects,
            transferredObjects: Math.max(prevTransferred, effectiveTransferred),
            skippedObjects: rerunNoOverwrite ? effectiveSkipped : Math.max(prevSkipped, effectiveSkipped),
            failedObjects: rerunNoOverwrite ? effectiveFailed : Math.max(prevFailed, effectiveFailed),
            processedObjects: rerunNoOverwrite ? nextProcessed : Math.max(prevProcessed, nextProcessed),
            status: normalized.status ?? effectiveStatus ?? null,
            updatedAt: new Date().toISOString(),
          }

          const shouldRefreshLogs =
            nextFailed > 0 ||
            prevFailed > 0 ||
            normalizeSlurperStatus(effectiveStatus) === "failed" ||
            normalizeSlurperStatus(effectiveStatus) === "copy_failed" ||
            normalizeSlurperStatus(effectiveStatus) === "running"

          const liveLogs = shouldRefreshLogs
            ? await collectLiveJobLogs({
                accountId: target.cloudflareAccountId!,
                apiToken: target.apiToken,
                jobId: item.slurperJobId,
                maxPages: nextFailed > 0 || prevFailed > 0 ? 6 : 2,
              }).catch(() => null)
            : null

          await updateMigrationItem(item.id, {
            slurperStatus: effectiveStatus,
            ...(typeof normalized.objects === "number" &&
            normalized.objects > 0 &&
            (typeof item.sourceObjects !== "number" || item.sourceObjects === 0)
              ? { sourceObjects: normalized.objects }
              : {}),
            progress: {
              ...item.progress,
              slurper: progress,
              slurperNormalized: normalized,
              slurperCumulative,
              pollingWarning: null,
              pollingWarningAt: null,
              ...(liveLogs ? { logs: liveLogs, logsFetchedAt: new Date().toISOString() } : {}),
            },
            lastProgressAt: new Date().toISOString(),
          })
        } catch (error: unknown) {
          const message = formatCloudflareError(error, "Unable to fetch job progress")
          if (!shouldPollSlurperProgress(item)) return
          await updateMigrationItem(item.id, {
            // Progress polling failures do not mean the Cloudflare copy job itself failed.
            // Keep the last real bucket status and record this as a warning only.
            progress: {
              ...item.progress,
              stage: "progress_poll_warning",
              pollingWarning: message,
              pollingWarningAt: new Date().toISOString(),
            },
            lastProgressAt: new Date().toISOString(),
          })
        }
      }
    )

    items = await listMigrationItems(id)

    // Create jobs up to the allowed global concurrent limit.
    const maxConcurrent = Math.max(
      1,
      Math.min(MAX_CLOUDFLARE_CONCURRENT_JOBS, Math.floor(migration.options.concurrency ?? 3))
    )
    const remoteActive = await slurperGetActiveJobCount({
      accountId: target.cloudflareAccountId!,
      apiToken: target.apiToken,
    }).catch(() => maxConcurrent)
    const availableSlots = Math.max(0, maxConcurrent - remoteActive)

    const overwrite = migration.options.overwrite ?? true

    const terminal = new Set(["completed", "aborted", "copy_completed", "copy_aborted"])
    const isLegacyCopy = (s: string) => s.startsWith("copy_")
    const failedLike = (s: string) => s.includes("failed") || s.includes("error") || s.endsWith("_failed") || s === "copy_failed"

    const startable = items.filter((item) => {
      if (item.slurperJobId) return false
      const status = String(item.slurperStatus ?? "queued").toLowerCase()
      if (terminal.has(status)) return false
      if (isLegacyCopy(status)) return false
      if (status === "creating_job" || status === "job_id_pending") return false
      if (failedLike(status) && status !== "rate_limited_bucket_create" && status !== "rate_limited_job_create") return false
      if (status === "bucket_create_failed" || status === "job_create_failed" || status === "precheck_failed") return false
      return true
    })

    if (availableSlots > 0 && startable.length > 0) {
      let createdCount = 0
      let hitLimit = false

      // Create jobs sequentially to keep Cloudflare happy (combined with global throttle in cloudflareFetchJson).
      for (const item of startable.slice(0, availableSlots)) {
        if (hitLimit) break
        try {
          try {
            await ensureTargetBucketExists({
              targetCloudflareAccountId: target.cloudflareAccountId!,
              targetApiToken: target.apiToken,
              bucketName: item.targetBucket,
              jurisdiction: mapToJurisdiction(item.sourceJurisdiction),
              storageClass:
                item.sourceStorageClass === "Standard" || item.sourceStorageClass === "InfrequentAccess"
                  ? item.sourceStorageClass
                  : undefined,
            })
          } catch (error: unknown) {
            if (isRateLimited(error)) {
              const delay = typeof error.retryAfterMs === "number" ? error.retryAfterMs : 5_000
              const message = `${formatCloudflareError(error, "Cloudflare rate limited bucket creation")} (retry in ~${Math.ceil(delay / 1000)}s)`
              await updateMigrationItem(item.id, {
                slurperStatus: "queued",
                progress: { ...item.progress, stage: "rate_limited_bucket_create", error: message },
                lastProgressAt: new Date().toISOString(),
              })
              continue
            }
            const message = formatCloudflareError(error, "Unable to create target bucket")
            await updateMigrationItem(item.id, {
              slurperStatus: "bucket_create_failed",
              progress: { ...item.progress, stage: "create_target_bucket", error: message },
              lastProgressAt: new Date().toISOString(),
            })
            continue
          }

          // Connectivity prechecks (target then source).
          try {
            await slurperConnectivityPrecheckTarget({
              accountId: target.cloudflareAccountId!,
              apiToken: target.apiToken,
              body: {
                vendor: "r2",
                bucket: item.targetBucket,
                secret: {
                  accessKeyId: target.r2AccessKeyId!,
                  secretAccessKey: target.r2SecretAccessKey!,
                },
                jurisdiction: mapToJurisdiction(item.sourceJurisdiction),
              },
            })
          } catch (error: unknown) {
            const message = formatCloudflareError(error, "Target preconnectivity failed")
            await updateMigrationItem(item.id, {
              slurperStatus: "precheck_failed",
              progress: { ...item.progress, stage: "precheck_target", error: message },
              lastProgressAt: new Date().toISOString(),
            })
            continue
          }

          const sourceSpecS3 = buildSourceSpec({
            bucket: item.sourceBucket,
            sourceAccountId: source.cloudflareAccountId!,
            accessKeyId: source.r2AccessKeyId!,
            secretAccessKey: source.r2SecretAccessKey!,
            pathPrefix: typeof pathPrefix !== "undefined" ? pathPrefix : undefined,
          })
          const sourceSpecR2 = buildSourceSpecR2Fallback({
            bucket: item.sourceBucket,
            accessKeyId: source.r2AccessKeyId!,
            secretAccessKey: source.r2SecretAccessKey!,
            jurisdiction: mapToJurisdiction(item.sourceJurisdiction),
            pathPrefix: typeof pathPrefix !== "undefined" ? pathPrefix : undefined,
          })

          let effectiveSource: SlurperSource = sourceSpecS3
          let s3Error = ""
          try {
            await slurperConnectivityPrecheckSource({
              accountId: target.cloudflareAccountId!,
              apiToken: target.apiToken,
              body: sourceSpecS3,
            })
          } catch (error2: unknown) {
            s3Error = formatCloudflareError(error2, "Source preconnectivity failed")
            try {
              await slurperConnectivityPrecheckSource({
                accountId: target.cloudflareAccountId!,
                apiToken: target.apiToken,
                body: sourceSpecR2,
              })
              effectiveSource = sourceSpecR2
            } catch (error3: unknown) {
              let message = `${s3Error} | r2 fallback: ${formatCloudflareError(error3, "Source preconnectivity failed (r2)")}`

              if (isRateLimited(error2) || isRateLimited(error3)) {
                const chosen = (isRateLimited(error2) ? error2 : error3) as CloudflareApiError
                const delay = typeof chosen.retryAfterMs === "number" ? chosen.retryAfterMs : 5_000
                message = `${message} | Cloudflare rate limited precheck (retry in ~${Math.ceil(delay / 1000)}s)`
                await updateMigrationItem(item.id, {
                  slurperStatus: "queued",
                  progress: { ...item.progress, stage: "rate_limited_precheck", error: message },
                  lastProgressAt: new Date().toISOString(),
                })
                continue
              }

              const destPermHint = await checkDestinationSlurperPermissions({
                accountId: target.cloudflareAccountId!,
                apiToken: target.apiToken,
              })
              if (destPermHint) message = `${message} | ${destPermHint}`

              try {
                await r2ListOneObject(
                  {
                    accountId: source.cloudflareAccountId!,
                    accessKeyId: source.r2AccessKeyId!,
                    secretAccessKey: source.r2SecretAccessKey!,
                  },
                  item.sourceBucket
                )
              } catch (awsErr: unknown) {
                message = `${message} | S3 check: ${formatAwsError(awsErr)}`
              }

              await updateMigrationItem(item.id, {
                slurperStatus: "precheck_failed",
                progress: {
                  ...item.progress,
                  stage: "precheck_source",
                  error: message,
                  sourceModeTried: sourceSpecS3.vendor,
                  sourceFallbackTried: sourceSpecR2.vendor,
                },
                lastProgressAt: new Date().toISOString(),
              })
              continue
            }
          }

          // Create the job (Cloudflare runs the migration; we only manage jobs).
          const forceRerunNoOverwrite =
            (isRecord(item.progress) ? (item.progress as Record<string, unknown>).rerunNoOverwrite : undefined) ===
            true
          const rerunCountRaw =
            isRecord(item.progress) && typeof (item.progress as Record<string, unknown>).rerunCount === "number"
              ? ((item.progress as Record<string, unknown>).rerunCount as number)
              : 0
          const rerunCount = Number.isFinite(rerunCountRaw) ? Math.max(0, Math.floor(rerunCountRaw)) : 0
          const jobName = forceRerunNoOverwrite
            ? `drive-migration-${migration.id}-${item.id}-rerun-${rerunCount || 1}-${Date.now()}`
            : `drive-migration-${migration.id}-${item.id}`
          const claimed = await claimMigrationItemJobCreation({
            itemId: item.id,
            progress: { ...item.progress, stage: "create_job", jobName },
          })
          if (!claimed) continue

          // Extra safety: if a job already exists for this item (from a previous request),
          // attach it instead of creating another one.
          const existingJobId = forceRerunNoOverwrite
            ? null
            : await slurperFindJobIdForBuckets({
                accountId: target.cloudflareAccountId!,
                apiToken: target.apiToken,
                sourceBucket: item.sourceBucket,
                targetBucket: item.targetBucket,
                jobName,
                requireNonTerminal: true,
                createdWithinMs: 10 * 60_000,
              }).catch(() => null)

          if (existingJobId) {
            await updateMigrationItem(item.id, {
              slurperJobId: String(existingJobId),
              slurperStatus: "running",
              progress: { ...item.progress, stage: "job_attached", jobName },
              lastProgressAt: new Date().toISOString(),
            })
            continue
          }

          const created = await slurperCreateJob({
            accountId: target.cloudflareAccountId!,
            apiToken: target.apiToken,
            job: {
              overwrite: forceRerunNoOverwrite ? false : overwrite,
              jobName,
              configuration: {
                overwriteObjects: forceRerunNoOverwrite ? false : overwrite,
              },
              source: effectiveSource,
              target: {
                vendor: "r2",
                bucket: item.targetBucket,
                secret: {
                  accessKeyId: target.r2AccessKeyId!,
                  secretAccessKey: target.r2SecretAccessKey!,
                },
                jurisdiction: mapToJurisdiction(item.sourceJurisdiction),
              },
            },
          })

          const jobId =
            slurperExtractCreatedJobId(created) ??
            (await slurperFindJobIdForBuckets({
              accountId: target.cloudflareAccountId!,
              apiToken: target.apiToken,
              sourceBucket: item.sourceBucket,
              targetBucket: item.targetBucket,
              jobName,
              createdWithinMs: 2 * 60_000,
              requireNonTerminal: true,
            }).catch(() => null))

          if (!jobId) {
            await updateMigrationItem(item.id, {
              slurperJobId: null,
              slurperStatus: "job_id_pending",
              progress: { ...item.progress, stage: "job_id_missing", jobName, lastError: "Cloudflare did not return a job id" },
              lastProgressAt: new Date().toISOString(),
            })
            continue
          }

          await updateMigrationItem(item.id, {
            slurperJobId: String(jobId),
            slurperStatus: "running",
            progress: { ...item.progress, stage: "job_created", jobName, sourceModeUsed: effectiveSource.vendor },
            lastProgressAt: new Date().toISOString(),
          })
          createdCount += 1
        } catch (error: unknown) {
          if (isJobLimitReached(error)) {
            hitLimit = true
            const message = `${formatCloudflareError(error, "Cloudflare job limit reached")} (will retry as jobs finish)`
            await updateMigrationItem(item.id, {
              slurperJobId: null,
              slurperStatus: "queued",
              progress: { ...item.progress, stage: "cloudflare_job_limit", error: message },
              lastProgressAt: new Date().toISOString(),
            })
            break
          }
          if (isRateLimited(error)) {
            const delay = typeof error.retryAfterMs === "number" ? error.retryAfterMs : 5_000
            const message = `${formatCloudflareError(error, "Cloudflare rate limited job creation")} (retry in ~${Math.ceil(delay / 1000)}s)`
            await updateMigrationItem(item.id, {
              slurperJobId: null,
              slurperStatus: "queued",
              progress: { ...item.progress, stage: "rate_limited_job_create", error: message },
              lastProgressAt: new Date().toISOString(),
            })
            continue
          }
          if (isCloudflareTransientError(error)) {
            const delayMs = typeof error.retryAfterMs === "number" ? error.retryAfterMs : 5_000
            const message = `${formatCloudflareError(error, "Cloudflare transient error")} (stopped after error; retry manually)`
            await updateMigrationItem(item.id, {
              slurperJobId: null,
              slurperStatus: "job_create_failed",
              progress: { ...item.progress, stage: "cloudflare_transient_error", error: message, lastError: message },
              lastProgressAt: new Date().toISOString(),
            })
            continue
          }

          const message = formatCloudflareError(error, "Unable to create Super Slurper job")
          await updateMigrationItem(item.id, {
            slurperJobId: null,
            slurperStatus: "job_create_failed",
            progress: { ...item.progress, stage: "create_job", error: message },
            lastProgressAt: new Date().toISOString(),
          })
        }
      }

      await updateMigration(id, {
        syncStatus: "ok",
        syncMessage: hitLimit
          ? "Cloudflare concurrent job limit reached (waiting for jobs to finish)"
          : createdCount > 0
            ? `Started ${createdCount} job${createdCount === 1 ? "" : "s"}`
            : "No new jobs started",
        lastSyncedAt: new Date().toISOString(),
      })
    }

    items = await listMigrationItems(id)

    // Post-copy verification: once Cloudflare marks a bucket "completed", we verify that every
    // source object exists in destination (and matches size). This is needed because the CF UI
    // can occasionally show phantom/incorrect listings, and Super Slurper can report skipped objects.
    const verifyEnabled = migration.options?.verifyAfterCopy !== false
    const verifyStrictDestination = migration.options?.verifyStrictDestination === true
    const verifyMode = migration.options?.verifyMode === "sha256-small" ? "sha256-small" : "keys-and-size"
    const verifyHashMaxBytes =
      typeof migration.options?.verifyHashMaxBytes === "number" && Number.isFinite(migration.options.verifyHashMaxBytes)
        ? Math.max(0, Math.floor(migration.options.verifyHashMaxBytes))
        : 8 * 1024 * 1024
    const verifyPrefix =
      typeof pathPrefix === "string" && pathPrefix.trim().length > 0 ? pathPrefix : undefined

    const isSuccessStatus = (s: string | undefined) => {
      const status = String(s ?? "").toLowerCase()
      return (
        status === "completed" ||
        status === "copy_completed" ||
        status === "complete" ||
        status === "finished" ||
        status === "success" ||
        status === "succeeded"
      )
    }

    if (verifyEnabled) {
      const sourceR2 = {
        accountId: source.cloudflareAccountId!,
        accessKeyId: source.r2AccessKeyId!,
        secretAccessKey: source.r2SecretAccessKey!,
      }
      const destR2 = {
        accountId: target.cloudflareAccountId!,
        accessKeyId: target.r2AccessKeyId!,
        secretAccessKey: target.r2SecretAccessKey!,
      }

      // Seed verify state for newly-completed buckets.
      const needsSeed = items.filter((item) => {
        if (!isSuccessStatus(item.slurperStatus)) return false
        return readBucketVerifyState(item.progress) === null
      })
      if (needsSeed.length > 0) {
        await promisePool(needsSeed, 3, async (item) => {
          await updateMigrationItem(item.id, {
            progress: {
              ...item.progress,
              stage: "verify_seeded",
              error: null,
              lastError: null,
              verifySamples: null,
              verify: createInitialBucketVerifyState({ prefix: verifyPrefix }),
            },
            lastProgressAt: new Date().toISOString(),
          })
        })
        items = await listMigrationItems(id)
      }

      // Advance verification a little on each /sync call to avoid timeouts for large buckets.
      const toVerify = items.filter((item) => {
        if (!isSuccessStatus(item.slurperStatus)) return false
        const v = readBucketVerifyState(item.progress) ?? createInitialBucketVerifyState({ prefix: verifyPrefix })
        return v.status === "pending" || v.status === "running"
      })

      // Keep this low: verification can be heavy; repeated polling will continue it.
      const batch = toVerify.slice(0, 2)
      if (batch.length > 0) {
        await promisePool(batch, 1, async (item) => {
          const p = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
          const sourceScanId = typeof p.sourceScanId === "string" ? p.sourceScanId : ""
          if (!sourceScanId) return

          const currentVerify =
            readBucketVerifyState(item.progress) ?? createInitialBucketVerifyState({ prefix: verifyPrefix })

          const destScanIdExisting = typeof p.destScanId === "string" ? p.destScanId : ""
          const destScan = destScanIdExisting
            ? await getBucketScan(destScanIdExisting).catch(() => null)
            : await ensureBucketScan({
                accountId: target.id,
                bucketName: item.targetBucket,
                kind: "dest",
                migrationId: id,
                migrationItemId: item.id,
                prefix: verifyPrefix,
              })

          const destScanId = destScan?.id ?? destScanIdExisting
          if (destScanId && destScanId !== destScanIdExisting) {
            await updateMigrationItem(item.id, {
              progress: { ...item.progress, stage: "verify_seeded", destScanId, error: null, lastError: null, verifySamples: null },
              lastProgressAt: new Date().toISOString(),
            })
          }

          const destScanRow = destScanId ? await getBucketScan(destScanId).catch(() => null) : null
          const sourceScanRow = await getBucketScan(sourceScanId).catch(() => null)
          if (!sourceScanRow) {
            const nowIso = new Date().toISOString()
            await updateMigrationItem(item.id, {
              progress: {
                ...item.progress,
                stage: "verify_progress",
                error: "Source scan missing (cannot verify)",
                verify: { ...currentVerify, status: "error", updatedAt: nowIso, finishedAt: nowIso, lastError: "Source scan missing (cannot verify)" },
              },
              lastProgressAt: nowIso,
            })
            return
          }
          if (sourceScanRow.status === "failed") {
            if (isTransientNetworkError(sourceScanRow.error ?? "")) {
              const replacementSourceScan = await ensureBucketScan({
                accountId: source.id,
                bucketName: item.sourceBucket,
                kind: "source",
                migrationId: id,
                migrationItemId: item.id,
                prefix: scanPrefix ?? null,
              })
              await updateMigrationItem(item.id, {
                progress: {
                  ...item.progress,
                  stage: "scanning_source",
                  sourceScanId: replacementSourceScan.id,
                  sourceScanStatus: replacementSourceScan.status,
                  error: null,
                  lastError: null,
                },
                lastProgressAt: new Date().toISOString(),
              })
              return
            }
            const nowIso = new Date().toISOString()
            const msg = sourceScanRow.error || "Source scan failed (cannot verify)"
            await updateMigrationItem(item.id, {
              progress: {
                ...item.progress,
                stage: "verify_progress",
                error: msg,
                verify: { ...currentVerify, status: "error", updatedAt: nowIso, finishedAt: nowIso, lastError: msg },
              },
              lastProgressAt: nowIso,
            })
            return
          }
          if (destScanRow && destScanRow.status === "failed") {
            if (isTransientNetworkError(destScanRow.error ?? "")) {
              const replacementDestScan = await ensureBucketScan({
                accountId: target.id,
                bucketName: item.targetBucket,
                kind: "dest",
                migrationId: id,
                migrationItemId: item.id,
                prefix: verifyPrefix ?? null,
              })
              await updateMigrationItem(item.id, {
                progress: {
                  ...item.progress,
                  stage: "verify_seeded",
                  destScanId: replacementDestScan.id,
                  error: null,
                  lastError: null,
                },
                lastProgressAt: new Date().toISOString(),
              })
              return
            }
            const nowIso = new Date().toISOString()
            const msg = destScanRow.error || "Destination scan failed (cannot verify)"
            await updateMigrationItem(item.id, {
              progress: {
                ...item.progress,
                stage: "verify_progress",
                error: msg,
                verify: { ...currentVerify, status: "error", updatedAt: nowIso, finishedAt: nowIso, lastError: msg },
              },
              lastProgressAt: nowIso,
            })
            return
          }
          if (!destScanRow || (destScanRow.status !== "completed" && destScanRow.status !== "failed")) {
            // Continue destination scan.
            try {
              const updated = await runBucketScanBatch({
                scanId: destScanId,
                r2: destR2,
                bucketName: item.targetBucket,
                prefix: verifyPrefix ?? null,
                maxObjects: 2_000,
              })
              const nowIso = new Date().toISOString()
              await updateMigrationItem(item.id, {
                progress: {
                  ...item.progress,
                  stage: "verify_scanning_dest",
                  error: null,
                  lastError: null,
                  verifySamples: null,
                  verify: {
                    ...currentVerify,
                    status: "running",
                    updatedAt: nowIso,
                    sourceListedObjects: sourceScanRow.objects ?? currentVerify.sourceListedObjects ?? 0,
                    destListedObjects: updated.objects ?? currentVerify.destListedObjects ?? 0,
                  },
                },
                lastProgressAt: nowIso,
              })
            } catch (e: unknown) {
              const message =
                typeof e === "object" && e !== null && "message" in e
                  ? String((e as { message?: unknown }).message ?? "Destination scan failed")
                  : "Destination scan failed"
              const nowIso = new Date().toISOString()
              if (isTransientNetworkError(e)) {
                await updateMigrationItem(item.id, {
                  progress: {
                    ...item.progress,
                    stage: "verify_scanning_dest",
                    error: null,
                    lastError: message,
                    verify: {
                      ...currentVerify,
                      status: "running",
                      updatedAt: nowIso,
                      lastError: message,
                    },
                  },
                  lastProgressAt: nowIso,
                })
              } else {
                await markBucketScanFailed({ scanId: destScanId, error: message })
                await updateMigrationItem(item.id, {
                  progress: {
                    ...item.progress,
                    stage: "verify_dest_scan_failed",
                    error: message,
                    verify: { ...currentVerify, status: "error", updatedAt: nowIso, finishedAt: nowIso, lastError: message },
                  },
                  lastProgressAt: nowIso,
                })
              }
            }
            return
          }

          // Both scans complete: compute diffs from stored inventories.
          let summary: Awaited<ReturnType<typeof computeAndStoreVerifyDiffs>>
          try {
            summary = await computeAndStoreVerifyDiffs({
              migrationItemId: item.id,
              sourceScanId,
              destScanId,
              strictDestination: verifyStrictDestination,
              sampleLimit: 25,
            })
          } catch (e: unknown) {
            const nowIso = new Date().toISOString()
            const msg =
              typeof e === "object" && e !== null && "message" in e
                ? String((e as { message?: unknown }).message ?? "Verification diff computation failed")
                : "Verification diff computation failed"
            await updateMigrationItem(item.id, {
              progress: {
                ...item.progress,
                stage: "verify_progress",
                error: msg,
                verify: { ...currentVerify, status: "error", updatedAt: nowIso, finishedAt: nowIso, lastError: msg },
              },
              lastProgressAt: nowIso,
            })
            return
          }

          const nowIso = new Date().toISOString()
          const nextVerify = {
            ...(readBucketVerifyState(item.progress) ?? createInitialBucketVerifyState({ prefix: verifyPrefix })),
            status:
              summary.note === "no_source_objects"
                ? "ok"
                : summary.missing === 0 && summary.sizeMismatched === 0 && (!verifyStrictDestination || summary.extra === 0)
                  ? "ok"
                  : "error",
            updatedAt: nowIso,
            finishedAt: nowIso,
            missingInDest: summary.missing,
            sizeMismatched: summary.sizeMismatched,
            extraInDest: summary.extra,
            sampleMissingKeys: summary.sampleMissingKeys,
            sampleMismatchedKeys: summary.sampleMismatchedKeys,
            sampleExtraKeys: summary.sampleExtraKeys,
            note: summary.note ?? "",
            lastError:
              summary.missing > 0
                ? `Verification failed: ${summary.missing} source objects missing in destination`
                : summary.sizeMismatched > 0
                  ? `Verification failed: ${summary.sizeMismatched} objects have size mismatches`
                  : verifyStrictDestination && summary.extra > 0
                    ? `Verification failed: ${summary.extra} extra objects in destination`
                    : "",
          }

          await updateMigrationItem(item.id, {
            progress: {
              ...item.progress,
              stage: "verify_progress",
              ...(nextVerify.status === "error"
                ? {
                    error: nextVerify.lastError || "Verification failed",
                    verifySamples: {
                      missing: nextVerify.sampleMissingKeys ?? [],
                      mismatched: nextVerify.sampleMismatchedKeys ?? [],
                      extra: nextVerify.sampleExtraKeys ?? [],
                    },
                  }
                : {
                    error: null,
                    lastError: null,
                    verifySamples: null,
                    ...(nextVerify.note === "no_source_objects" ? { verifyNote: "No files exist in source bucket" } : {}),
                  }),
              verify: nextVerify,
            },
            lastProgressAt: new Date().toISOString(),
          })
        })

        items = await listMigrationItems(id)
      }
    }

    await syncMigrationLiveState(id).catch(() => undefined)
    items = await listMigrationItems(id)
    return NextResponse.json({ migration: await getMigration(id), items }, { status: 200 })
  } catch (error: unknown) {
    const message = formatCloudflareError(error, "Unable to sync migration")
    try {
      const { id } = await context.params
      await updateMigration(id, {
        syncStatus: "error",
        syncMessage: message,
        lastSyncedAt: new Date().toISOString(),
      })
    } catch {
      // ignore
    }
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
