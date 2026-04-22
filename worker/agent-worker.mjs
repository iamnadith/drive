import { S3Client, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import os from "os"

function getArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return process.env[name.toUpperCase().replace(/-/g, "_")] || fallback
}

const SERVER_URL = String(getArg("server-url", "")).replace(/\/+$/, "")
const AGENT_ID = String(getArg("agent-id", ""))
const AGENT_TOKEN = String(getArg("token", ""))
const POLL_MS = Math.max(5_000, Number(getArg("poll-ms", "15000")) || 15_000)
const HEARTBEAT_MS = Math.max(10_000, Number(getArg("heartbeat-ms", "20000")) || 20_000)
const MAX_OBJECTS = Math.max(1, Math.min(500_000, Number(getArg("max-objects", "200000")) || 200_000))
const API_TIMEOUT_MS = Math.max(5_000, Number(getArg("api-timeout-ms", "30000")) || 30_000)
const API_RETRIES = Math.max(1, Math.min(6, Number(getArg("api-retries", "3")) || 3))
const S3_RETRIES = Math.max(1, Math.min(6, Number(getArg("s3-retries", "3")) || 3))
const HEARTBEAT_TIMEOUT_MS = Math.max(API_TIMEOUT_MS, 60_000)
const HEARTBEAT_RETRIES = Math.max(API_RETRIES, 5)
const SUPABASE_TIMEOUT_MS = Math.max(1_000, Number(getArg("supabase-timeout-ms", "5000")) || 5_000)
const EXIT_AFTER_JOB = ["1", "true", "yes"].includes(
  String(getArg("exit-after-job", process.env.GITHUB_ACTIONS === "true" ? "true" : "false")).toLowerCase()
)
const SUPABASE_URL = String(getArg("supabase-url", process.env.NEXT_PUBLIC_SUPABASE_URL || ""))
const SUPABASE_SERVICE_ROLE_KEY = String(getArg("supabase-service-role-key", ""))
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null
const migrationItemProgressCache = new Map()
const repairJobProgressCache = new Map()

if (!SERVER_URL || !AGENT_ID || !AGENT_TOKEN) {
  console.error("Missing required configuration. Use --server-url, --agent-id, and --token.")
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout(label, promise, timeoutMs = SUPABASE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

function isRecord(value) {
  return typeof value === "object" && value !== null
}

function closeBodyStream(body) {
  if (body && typeof body.destroy === "function") {
    try {
      body.destroy()
    } catch {}
  }
}

function isRetryableError(error) {
  const name = typeof error?.name === "string" ? error.name.toLowerCase() : ""
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase()
  const status = Number(error?.$metadata?.httpStatusCode || 0)
  return (
    name === "aborterror" ||
    name === "timeouterror" ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted") ||
    message.includes("aborterror") ||
    message.includes("request aborted") ||
    message.includes("stream closed") ||
    message.includes("premature close") ||
    message.includes("ecanceled") ||
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("slow down") ||
    message.includes("thrott") ||
    message.includes("internalerror") ||
    message.includes("service unavailable") ||
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    message.includes("530") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("500")
  )
}

function isObjectNotFoundError(error) {
  const code = typeof error?.name === "string" ? error.name.toLowerCase() : ""
  const status = Number(error?.$metadata?.httpStatusCode || 0)
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase()
  return (
    code === "notfound" ||
    code === "nosuchkey" ||
    code === "nosuchbucket" ||
    status === 404 ||
    message.includes("not found") ||
    message.includes("nosuchkey")
  )
}

async function withRetries(label, fn, retries = 3) {
  let lastError = null
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      if (attempt >= retries || !isRetryableError(error)) throw error
      await sleep(Math.min(5000, 400 * 2 ** (attempt - 1)))
    }
  }
  throw lastError || new Error(`${label} failed`)
}

class JobAbortedError extends Error {
  constructor(message = "Worker job aborted by user") {
    super(message)
    this.name = "JobAbortedError"
  }
}

function createClient(config) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

async function api(path, body, options = {}) {
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : API_TIMEOUT_MS
  const retries =
    typeof options.retries === "number" && Number.isFinite(options.retries) && options.retries > 0
      ? Math.trunc(options.retries)
      : API_RETRIES
  return withRetries(
    `api ${path}`,
    async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(`${SERVER_URL}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        const json = await response.json().catch(() => ({}))
        if (!response.ok) {
          const message = typeof json.error === "string" ? json.error : `Request failed: ${response.status}`
          if (response.status >= 500 || response.status === 429) throw new Error(message)
          throw new Error(message)
        }
        return json
      } finally {
        clearTimeout(timeout)
      }
    },
    retries
  )
}

async function heartbeat(extra = {}) {
  if (supabase) {
    await withTimeout(
      "supabase worker heartbeat",
      supabase
        .from("drive_agents")
        .update({
          status: "online",
          last_heartbeat_at: new Date().toISOString(),
          last_seen_host: os.hostname(),
          last_seen_version: "worker-v1",
          metadata: extra,
          updated_at: new Date().toISOString(),
        })
        .eq("id", AGENT_ID)
    ).catch(() => undefined)
  }
  return api(
    `/api/workers/${encodeURIComponent(AGENT_ID)}/heartbeat`,
    {
      token: AGENT_TOKEN,
      host: os.hostname(),
      version: "worker-v1",
      capabilities: ["scan", "verify", "repair", "diagnostics"],
      metadata: extra,
    },
    { timeoutMs: HEARTBEAT_TIMEOUT_MS, retries: HEARTBEAT_RETRIES }
  )
}

async function claimJob() {
  return api(`/api/workers/${encodeURIComponent(AGENT_ID)}/claim-job`, {
    token: AGENT_TOKEN,
  })
}

async function updateMigrationItemLocal(migrationId, itemUpdate) {
  if (!supabase || !migrationId || !itemUpdate || typeof itemUpdate !== "object") return

  const itemId = typeof itemUpdate.itemId === "string" ? itemUpdate.itemId : ""
  if (!itemId) return

  const now = new Date().toISOString()
  const stage = typeof itemUpdate.stage === "string" ? itemUpdate.stage : "repair_progress"
  const status = typeof itemUpdate.status === "string" ? itemUpdate.status : "running"
  const summary = typeof itemUpdate.summary === "string" ? itemUpdate.summary : undefined
  const details = isRecord(itemUpdate.details) ? itemUpdate.details : undefined
  const transferred = typeof itemUpdate.transferred === "number" ? itemUpdate.transferred : undefined
  const failed = typeof itemUpdate.failed === "number" ? itemUpdate.failed : undefined
  const skipped = typeof itemUpdate.skipped === "number" ? itemUpdate.skipped : undefined
  const cacheKey = `${migrationId}:${itemId}`
  let currentRow = migrationItemProgressCache.get(cacheKey) || null

  if (!currentRow) {
    const selectResult = await withTimeout(
      `supabase load migration item ${itemId}`,
      supabase
        .from("drive_migration_items")
        .select("progress, slurper_status")
        .eq("id", itemId)
        .eq("migration_id", migrationId)
        .limit(1)
    ).catch(() => ({ data: null }))
    const data = selectResult && typeof selectResult === "object" ? selectResult.data : null
    currentRow = Array.isArray(data) ? data[0] : null
  }

  const currentProgress = isRecord(currentRow?.progress) ? currentRow.progress : {}
  const repair = isRecord(currentProgress.repairWorker) ? currentProgress.repairWorker : {}
  const live = isRecord(currentProgress.live) ? currentProgress.live : {}
  const sourceObjectCount =
    typeof details.sourceObjectCount === "number"
      ? details.sourceObjectCount
      : typeof live.totalObjects === "number"
        ? live.totalObjects
        : 0
  const liveStatus =
    status === "completed"
      ? (typeof details.finalMissing === "number" ? details.finalMissing : 0) === 0 &&
        (typeof details.finalMismatched === "number" ? details.finalMismatched : 0) === 0
        ? "completed"
        : "failed"
      : status === "failed"
        ? "failed"
        : status === "canceled"
          ? "aborted"
          : stage.includes("scan")
            ? "scanning"
            : stage.includes("verify")
              ? "verifying"
              : "running"

  const nextRepair = {
    ...repair,
    stage,
    status,
    updatedAt: now,
    ...(summary ? { summary } : {}),
    ...(details ? { details } : {}),
    ...(typeof transferred === "number" ? { transferred } : {}),
    ...(typeof failed === "number" ? { failed } : {}),
    ...(typeof skipped === "number" ? { skipped } : {}),
  }

  const nextProgress = {
    ...currentProgress,
    stage,
    repairWorker: nextRepair,
    live: {
      ...live,
      updatedAt: now,
      status: liveStatus,
      transferredObjects:
        liveStatus === "completed" && sourceObjectCount > 0
          ? Math.max(typeof transferred === "number" ? transferred : 0, Math.max(0, sourceObjectCount - (typeof skipped === "number" ? skipped : 0)))
          : typeof transferred === "number"
            ? transferred
            : typeof live.transferredObjects === "number"
              ? live.transferredObjects
              : 0,
      skippedObjects: typeof skipped === "number" ? skipped : typeof live.skippedObjects === "number" ? live.skippedObjects : 0,
      failedObjects:
        liveStatus === "completed"
          ? 0
          : Math.max(
              typeof failed === "number" ? failed : 0,
              (typeof details.finalMissing === "number" ? details.finalMissing : 0) +
                (typeof details.finalMismatched === "number" ? details.finalMismatched : 0)
            ),
      unaccountedObjects:
        liveStatus === "completed" ? 0 : typeof live.unaccountedObjects === "number" ? live.unaccountedObjects : 0,
      verifyIssues:
        liveStatus === "completed"
          ? 0
          : (typeof details.finalMissing === "number" ? details.finalMissing : 0) +
            (typeof details.finalMismatched === "number" ? details.finalMismatched : 0),
      totalObjects: sourceObjectCount,
      workerStage: stage || null,
      workerStatus: status || null,
    },
    repairWorkerStatus: status,
    ...(summary ? { syncMessage: summary } : {}),
    ...(status === "failed" && summary ? { error: summary, lastError: summary } : {}),
  }

  const nextSlurperStatus =
    status === "completed"
      ? "completed"
      : status === "failed"
        ? "verification_failed"
        : typeof currentRow?.slurper_status === "string"
          ? currentRow.slurper_status
          : null

  await withTimeout(
    `supabase update migration item ${itemId}`,
    supabase
      .from("drive_migration_items")
      .update({
        progress: nextProgress,
        slurper_status: nextSlurperStatus,
        last_progress_at: now,
        updated_at: now,
      })
      .eq("id", itemId)
      .eq("migration_id", migrationId)
  ).catch(() => undefined)

  migrationItemProgressCache.set(cacheKey, {
    progress: nextProgress,
    slurper_status: nextSlurperStatus,
  })
}

async function updateMigrationLocal(migrationId, body) {
  if (!supabase || !migrationId || !body || typeof body !== "object") return

  const now = new Date().toISOString()
  const status = typeof body.status === "string" ? body.status : undefined
  const summary = typeof body.summary === "string" ? body.summary : undefined
  const error = typeof body.error === "string" ? body.error : undefined

  if (status === "completed") {
    await withTimeout(
      `supabase update migration ${migrationId} completed`,
      supabase
        .from("drive_migrations")
        .update({
          sync_status: "ok",
          sync_message: summary || "Worker reconciliation completed",
          last_synced_at: now,
          updated_at: now,
        })
        .eq("id", migrationId)
    ).catch(() => undefined)
    return
  }

  if (status === "failed") {
    await withTimeout(
      `supabase update migration ${migrationId} failed`,
      supabase
        .from("drive_migrations")
        .update({
          status: "failed",
          sync_status: "error",
          sync_message: error || summary || "Worker reconciliation failed",
          last_synced_at: now,
          updated_at: now,
        })
        .eq("id", migrationId)
    ).catch(() => undefined)
    return
  }

  if (status === "canceled") {
    await withTimeout(
      `supabase update migration ${migrationId} canceled`,
      supabase
        .from("drive_migrations")
        .update({
          sync_status: "ok",
          sync_message: summary || "Worker reconciliation aborted",
          last_synced_at: now,
          updated_at: now,
        })
        .eq("id", migrationId)
    ).catch(() => undefined)
  }
}

async function updateJob(jobId, body, options = {}) {
  const allowOffline = options?.allowOffline === true
  if (supabase) {
    const status = typeof body.status === "string" ? body.status : undefined
    const progress = body.progress && typeof body.progress === "object" ? body.progress : undefined
    const result = body.result && typeof body.result === "object" ? body.result : undefined
    const summary = typeof body.summary === "string" ? body.summary : undefined
    const error = typeof body.error === "string" ? body.error : undefined
    const now = new Date().toISOString()
    const localPersistence = (async () => {
      let currentRow = repairJobProgressCache.get(jobId) || null
      if (!currentRow) {
        const selectResult = await withTimeout(
          `supabase load repair job ${jobId}`,
          supabase
            .from("drive_repair_jobs")
            .select("progress, result")
            .eq("id", jobId)
            .limit(1)
        ).catch(() => ({ data: null }))
        const data = selectResult && typeof selectResult === "object" ? selectResult.data : null
        currentRow = Array.isArray(data) ? data[0] : null
      }

      const currentProgress = isRecord(currentRow?.progress) ? currentRow.progress : {}
      const currentResult = isRecord(currentRow?.result) ? currentRow.result : {}
      const mergedProgress = progress ? { ...currentProgress, ...progress } : undefined
      const mergedResult = result ? { ...currentResult, ...result } : undefined

      await withTimeout(
        `supabase update repair job ${jobId}`,
        supabase
          .from("drive_repair_jobs")
          .update({
            ...(status ? { status } : {}),
            ...(mergedProgress ? { progress: mergedProgress } : {}),
            ...(mergedResult ? { result: mergedResult } : {}),
            ...(summary !== undefined ? { summary } : {}),
            ...(error !== undefined ? { error } : {}),
            last_heartbeat_at: now,
            updated_at: now,
            ...((status === "completed" || status === "failed" || status === "canceled") ? { completed_at: now } : {}),
          })
          .eq("id", jobId)
      ).catch(() => undefined)

      if (currentMigrationId && Array.isArray(body.items)) {
        for (const itemUpdate of body.items) {
          await updateMigrationItemLocal(currentMigrationId, itemUpdate).catch(() => undefined)
        }
      }

      if (currentMigrationId && (status === "completed" || status === "failed" || status === "canceled")) {
        await updateMigrationLocal(currentMigrationId, body).catch(() => undefined)
      }

      repairJobProgressCache.set(jobId, {
        progress: mergedProgress || currentProgress,
        result: mergedResult || currentResult,
      })
    })()

    void localPersistence.catch(() => undefined)
  }
  let response
  try {
    response = await api(`/api/workers/${encodeURIComponent(AGENT_ID)}/jobs/${encodeURIComponent(jobId)}`, {
      token: AGENT_TOKEN,
      ...body,
    })
  } catch (error) {
    if (allowOffline && !(error instanceof JobAbortedError) && isRetryableError(error)) {
      return { offline: true, error: error instanceof Error ? error.message : String(error) }
    }
    throw error
  }
  if (response?.canceled || response?.job?.status === "canceled") {
    throw new JobAbortedError()
  }
  return response
}

async function safeUpdateJob(jobId, body) {
  try {
    const response = await updateJob(jobId, body, { allowOffline: true })
    if (response?.offline) {
      console.error(`Job sync deferred for ${jobId}: ${response.error}`)
    }
    return response
  } catch (error) {
    if (error instanceof JobAbortedError) throw error
    console.error(`Job sync failed for ${jobId}:`, error instanceof Error ? error.message : String(error))
    return { offline: true, error: error instanceof Error ? error.message : String(error) }
  }
}

async function finalizeJobUpdate(jobId, body) {
  try {
    const response = await updateJob(jobId, body, { allowOffline: true })
    if (response?.offline) {
      console.error(`Final job update deferred for ${jobId}: ${response.error}`)
    }
    return response
  } catch (error) {
    if (error instanceof JobAbortedError) throw error
    console.error(`Final job update failed for ${jobId}:`, error instanceof Error ? error.message : String(error))
    return { offline: true, error: error instanceof Error ? error.message : String(error) }
  }
}

async function tryClaimJob() {
  try {
    return await claimJob()
  } catch (error) {
    if (isRetryableError(error)) {
      console.error(`Claim job failed:`, error instanceof Error ? error.message : String(error))
      return null
    }
    throw error
  }
}

async function listAllObjects(client, bucket, prefix, onProgress) {
  const objects = []
  let continuationToken = undefined
  const seenTokens = new Set()
  while (true) {
    const tokenKey = continuationToken || "__first__"
    if (seenTokens.has(tokenKey)) throw new Error(`ListObjectsV2 pagination loop detected for ${bucket}`)
    seenTokens.add(tokenKey)
    const page = await withRetries(
      `list objects ${bucket}`,
      () =>
        client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix || undefined,
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          })
        ),
      S3_RETRIES
    )
    const contents = Array.isArray(page.Contents) ? page.Contents : []
    for (const object of contents) {
      const key = typeof object?.Key === "string" ? object.Key : ""
      if (!key) continue
      const size = typeof object?.Size === "number" ? object.Size : 0
      objects.push({ key, size })
      if (typeof onProgress === "function") onProgress({ count: objects.length, key, size })
      if (objects.length >= MAX_OBJECTS) return objects
    }
    continuationToken = typeof page.NextContinuationToken === "string" ? page.NextContinuationToken : undefined
    if (!continuationToken) return objects
  }
}

function diffObjects(sourceObjects, destObjects) {
  const destinationMap = new Map(destObjects.map((object) => [object.key, object.size]))
  const missing = []
  const mismatched = []
  for (const sourceObject of sourceObjects) {
    const destSize = destinationMap.get(sourceObject.key)
    if (typeof destSize === "undefined") {
      missing.push(sourceObject)
    } else if (destSize !== sourceObject.size) {
      mismatched.push({ ...sourceObject, destinationSize: destSize })
    }
  }
  return { missing, mismatched }
}

async function getTargetObjectSize(targetClient, bucket, key) {
  try {
    const head = await withRetries(
      `head target ${bucket}/${key}`,
      () => targetClient.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
      S3_RETRIES
    )
    return typeof head.ContentLength === "number" ? head.ContentLength : 0
  } catch (error) {
    if (isObjectNotFoundError(error)) return null
    throw error
  }
}

function diffObjectsByListing(sourceObjects, destObjects, onProgress) {
  const destinationMap = new Map(destObjects.map((object) => [object.key, object.size]))
  const missing = []
  const mismatched = []
  let checked = 0

  for (const sourceObject of sourceObjects) {
    const destSize = destinationMap.get(sourceObject.key)
    checked += 1
    if (typeof destSize === "undefined") {
      missing.push(sourceObject)
    } else if (destSize !== sourceObject.size) {
      mismatched.push({ ...sourceObject, destinationSize: destSize })
    }
    if (typeof onProgress === "function") {
      onProgress({
        checked,
        key: sourceObject.key,
        size: sourceObject.size,
        missing: missing.length,
        mismatched: mismatched.length,
      })
    }
  }

  return { missing, mismatched }
}

function buildLiveTotals(resultItems, current = {}) {
  const completedItems = Array.isArray(resultItems) ? resultItems : []
  const totals = {
    transferred: 0,
    failed: 0,
    skipped: 0,
    missing: 0,
    mismatched: 0,
    completedItems: 0,
    failedItems: 0,
  }

  for (const item of completedItems) {
    totals.transferred += Number(item?.transferred || 0)
    totals.failed += Number(item?.failed || 0)
    totals.skipped += Number(item?.skipped || 0)
    totals.missing += Number(item?.finalMissing || 0)
    totals.mismatched += Number(item?.finalMismatched || 0)
    if (item?.completed) totals.completedItems += 1
    else totals.failedItems += 1
  }

  totals.transferred += Number(current.transferred || 0)
  totals.failed += Number(current.failed || 0)
  totals.skipped += Number(current.skipped || 0)
  totals.missing += Number(current.missing || 0)
  totals.mismatched += Number(current.mismatched || 0)

  return totals
}

function createJobTelemetry(payload) {
  return {
    startedAt: new Date().toISOString(),
    logs: [],
    itemProgress: [],
    fileEvents: [],
    currentFile: null,
    stats: {
      totalBuckets: Array.isArray(payload?.items) ? payload.items.length : 0,
      completedBuckets: 0,
      failedBuckets: 0,
      scannedSourceObjects: 0,
      scannedDestinationObjects: 0,
      repairCandidates: 0,
      verifiedObjects: 0,
    },
  }
}

function pushLog(state, message, extra = {}) {
  const line = {
    at: new Date().toISOString(),
    message: String(message),
    ...extra,
  }
  state.logs = [...state.logs.slice(-199), line]
}

function upsertItemProgress(state, patch) {
  const itemId = typeof patch?.itemId === "string" ? patch.itemId : ""
  if (!itemId) return
  const next = {
    updatedAt: new Date().toISOString(),
    ...patch,
  }
  const index = state.itemProgress.findIndex((entry) => entry?.itemId === itemId)
  if (index < 0) state.itemProgress = [...state.itemProgress, next]
  else state.itemProgress = [...state.itemProgress.slice(0, index), { ...state.itemProgress[index], ...next }, ...state.itemProgress.slice(index + 1)]
}

function upsertFileEvent(state, patch) {
  const itemId = typeof patch?.itemId === "string" ? patch.itemId : ""
  const key = typeof patch?.key === "string" ? patch.key : ""
  if (!itemId || !key) return
  const next = {
    updatedAt: new Date().toISOString(),
    ...patch,
  }
  const index = state.fileEvents.findIndex((entry) => entry?.itemId === itemId && entry?.key === key)
  if (index < 0) state.fileEvents = [...state.fileEvents.slice(-4999), next]
  else state.fileEvents = [...state.fileEvents.slice(0, index), { ...state.fileEvents[index], ...next }, ...state.fileEvents.slice(index + 1)]
}

function buildTelemetryProgress(state, current = {}) {
  return {
    startedAt: state.startedAt,
    logs: state.logs,
    itemProgress: state.itemProgress,
    fileEvents: state.fileEvents,
    currentFile: state.currentFile,
    stats: state.stats,
    ...current,
  }
}

async function copyObject(sourceClient, targetClient, sourceBucket, targetBucket, key, options = {}) {
  await withRetries(
    `copy ${sourceBucket}/${key}`,
    async () => {
      const sourceResponse = await sourceClient.send(new GetObjectCommand({ Bucket: sourceBucket, Key: key }))
      const sourceHead = await sourceClient.send(new HeadObjectCommand({ Bucket: sourceBucket, Key: key }))
      const body = sourceResponse.Body
      if (!body) throw new Error(`Source object body missing for ${key}`)

      const upload = new Upload({
        client: targetClient,
        params: {
          Bucket: targetBucket,
          Key: key,
          Body: body,
          ...(typeof sourceHead.ContentType === "string" ? { ContentType: sourceHead.ContentType } : {}),
          ...(typeof sourceHead.CacheControl === "string" ? { CacheControl: sourceHead.CacheControl } : {}),
          ...(sourceHead.Metadata ? { Metadata: sourceHead.Metadata } : {}),
        },
        queueSize: 1,
        partSize: 16 * 1024 * 1024,
        leavePartsOnError: false,
      })
      if (typeof options.onProgress === "function") {
        upload.on("httpUploadProgress", (progress) => {
          options.onProgress({
            loaded: typeof progress?.loaded === "number" ? progress.loaded : 0,
            total:
              typeof progress?.total === "number"
                ? progress.total
                : typeof sourceHead.ContentLength === "number"
                  ? sourceHead.ContentLength
                  : 0,
          })
        })
      }

      try {
        await upload.done()
        const targetHead = await withRetries(
          `verify target head ${targetBucket}/${key}`,
          () => targetClient.send(new HeadObjectCommand({ Bucket: targetBucket, Key: key })),
          S3_RETRIES
        )
        const sourceSize = typeof sourceHead.ContentLength === "number" ? sourceHead.ContentLength : 0
        const targetSize = typeof targetHead.ContentLength === "number" ? targetHead.ContentLength : -1
        if (targetSize !== sourceSize) {
          throw new Error(`Size mismatch after copy for ${key}: source=${sourceSize} target=${targetSize}`)
        }
        return { sourceSize, targetSize }
      } finally {
        closeBodyStream(body)
      }
    },
    S3_RETRIES
  )
}

async function processItem(jobId, payload, item, completedResults, state) {
  const prefix = payload.migration?.pathPrefix || null
  const sourceClient = createClient(payload.source)
  const targetClient = createClient(payload.target)
  let stage = "repair_scan"
  let transferred = 0
  let failed = 0
  let skipped = 0
  let initialMissing = 0
  let initialMismatched = 0
  const failureSamples = []
  let sourceScanLastCount = 0
  let destinationScanLastCount = 0
  let currentStageStartedAt = new Date().toISOString()
  let lastLiveProgressSyncAt = 0

  const syncLiveProgress = (extra = {}) => {
    const nowTs = Date.now()
    if (nowTs - lastLiveProgressSyncAt < 3000) return
    lastLiveProgressSyncAt = nowTs
    void safeUpdateJob(jobId, {
      status: "running",
      progress: {
        ...buildTelemetryProgress(state, {
          currentItemId: item.id,
          currentBucket: item.sourceBucket,
          stage,
          transferred,
          failed,
          skipped,
          totals: buildLiveTotals(completedResults, {
            transferred,
            failed,
            skipped,
            ...(typeof extra.missing === "number" ? { missing: extra.missing } : {}),
            ...(typeof extra.mismatched === "number" ? { mismatched: extra.mismatched } : {}),
          }),
          ...extra,
        }),
      },
    })
  }

  const forceSyncLiveProgress = (extra = {}) => {
    lastLiveProgressSyncAt = Date.now()
    void safeUpdateJob(jobId, {
      status: "running",
      progress: {
        ...buildTelemetryProgress(state, {
          currentItemId: item.id,
          currentBucket: item.sourceBucket,
          stage,
          transferred,
          failed,
          skipped,
          totals: buildLiveTotals(completedResults, {
            transferred,
            failed,
            skipped,
            ...(typeof extra.missing === "number" ? { missing: extra.missing } : {}),
            ...(typeof extra.mismatched === "number" ? { mismatched: extra.mismatched } : {}),
          }),
          ...extra,
        }),
      },
    })
  }

  try {
    pushLog(state, `Scanning ${item.sourceBucket} -> ${item.targetBucket}`, {
      itemId: item.id,
      stage,
      bucket: item.sourceBucket,
    })
    upsertItemProgress(state, {
      itemId: item.id,
      sourceBucket: item.sourceBucket,
      targetBucket: item.targetBucket,
      stage,
      status: "running",
      transferred,
      failed,
      skipped,
      processedFiles: 0,
      totalFiles: 0,
      summary: `Scanning ${item.sourceBucket} -> ${item.targetBucket}`,
    })
    await safeUpdateJob(jobId, {
      status: "running",
      items: [
        {
          itemId: item.id,
          stage,
          status: "running",
          summary: `Scanning ${item.sourceBucket} -> ${item.targetBucket}`,
        },
      ],
      progress: {
        ...buildTelemetryProgress(state, {
          currentItemId: item.id,
          currentBucket: item.sourceBucket,
          stage,
          totals: buildLiveTotals(completedResults),
        }),
      },
    })

    const sourceObjects = await listAllObjects(sourceClient, item.sourceBucket, prefix, ({ count, key, size }) => {
      const delta = Math.max(0, count - sourceScanLastCount)
      sourceScanLastCount = count
      state.stats.scannedSourceObjects += delta
      state.currentFile = {
        itemId: item.id,
        bucket: item.sourceBucket,
        key: typeof key === "string" ? key : "",
        size: typeof size === "number" ? size : 0,
        stage,
        status: "scanning",
        startedAt: currentStageStartedAt,
        scanPhase: "source",
        scannedObjects: count,
        updatedAt: new Date().toISOString(),
      }
      upsertItemProgress(state, {
        itemId: item.id,
        stage,
        status: "running",
        scanSourceCount: count,
        summary: `Scanning ${item.sourceBucket}: ${count} source files found`,
      })
      syncLiveProgress()
    })
    const destinationObjects = await listAllObjects(targetClient, item.targetBucket, prefix, ({ count, key, size }) => {
      const delta = Math.max(0, count - destinationScanLastCount)
      destinationScanLastCount = count
      state.stats.scannedDestinationObjects += delta
      state.currentFile = {
        itemId: item.id,
        bucket: item.targetBucket,
        key: typeof key === "string" ? key : "",
        size: typeof size === "number" ? size : 0,
        stage,
        status: "scanning",
        startedAt: currentStageStartedAt,
        scanPhase: "destination",
        scannedObjects: count,
        updatedAt: new Date().toISOString(),
      }
      upsertItemProgress(state, {
        itemId: item.id,
        stage,
        status: "running",
        scanDestinationCount: count,
        summary: `Scanning ${item.targetBucket}: ${count} destination files found`,
      })
      syncLiveProgress()
    })
    const sourceBytes = sourceObjects.reduce((sum, object) => sum + Number(object?.size || 0), 0)
    const initialDiff = diffObjectsByListing(sourceObjects, destinationObjects, ({ checked, key, size, missing, mismatched }) => {
      state.currentFile = {
        itemId: item.id,
        bucket: item.sourceBucket,
        key: typeof key === "string" ? key : "",
        size: typeof size === "number" ? size : 0,
        stage,
        status: "verifying",
        startedAt: currentStageStartedAt,
        checkedObjects: checked,
        totalObjects: sourceObjects.length,
        missing,
        mismatched,
        updatedAt: new Date().toISOString(),
      }
      upsertItemProgress(state, {
        itemId: item.id,
        stage,
        status: "running",
        verifyCheckedCount: checked,
        initialMissing: missing,
        initialMismatched: mismatched,
        summary: `Comparing ${item.sourceBucket}: ${checked}/${sourceObjects.length} checked`,
      })
      syncLiveProgress({ verifyCheckedCount: checked, missing, mismatched })
    })
    initialMissing = initialDiff.missing.length
    initialMismatched = initialDiff.mismatched.length

    const toRepair = [...initialDiff.missing, ...initialDiff.mismatched]
    state.stats.repairCandidates += toRepair.length
    upsertItemProgress(state, {
      itemId: item.id,
      stage,
      status: "running",
      initialMissing,
      initialMismatched,
      totalFiles: toRepair.length,
      processedFiles: 0,
      summary: `Scan complete for ${item.sourceBucket}: ${initialMissing} missing, ${initialMismatched} mismatched`,
    })
    pushLog(state, `Scan complete for ${item.sourceBucket}`, {
      itemId: item.id,
      stage,
      initialMissing,
      initialMismatched,
      sourceCount: sourceObjects.length,
      destinationCount: destinationObjects.length,
    })

    if (payload.job.mode !== "verify_only") {
      stage = "repair_copy"
      currentStageStartedAt = new Date().toISOString()
      for (const object of toRepair) {
        const isMismatch = typeof object?.destinationSize === "number"
        const objectSize = typeof object?.size === "number" ? object.size : 0
        const latestTargetSize = await getTargetObjectSize(targetClient, item.targetBucket, object.key)
        if (latestTargetSize === objectSize) {
          skipped += 1
          upsertFileEvent(state, {
            itemId: item.id,
            bucket: item.sourceBucket,
            key: object.key,
            size: objectSize,
            kind: isMismatch ? "mismatched" : "missing",
            stage,
            status: "skipped",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            bytesTransferred: objectSize,
            bytesTotal: objectSize,
          })
          upsertItemProgress(state, {
            itemId: item.id,
            stage,
            status: "running",
            transferred,
            failed,
            skipped,
            processedFiles: transferred + failed + skipped,
            totalFiles: toRepair.length,
            summary: `Repairing ${item.sourceBucket}: ${transferred} copied, ${failed} failed, ${skipped} skipped`,
          })
          continue
        }
        const startedAt = new Date().toISOString()
        state.currentFile = {
          itemId: item.id,
          bucket: item.sourceBucket,
          key: object.key,
          size: objectSize,
          stage,
          status: "copying",
          startedAt,
          bytesTransferred: 0,
          bytesTotal: objectSize,
        }
        upsertFileEvent(state, {
          itemId: item.id,
          bucket: item.sourceBucket,
          key: object.key,
          size: objectSize,
          kind: isMismatch ? "mismatched" : "missing",
          stage,
          status: "copying",
          startedAt,
          bytesTransferred: 0,
          bytesTotal: objectSize,
        })
        forceSyncLiveProgress()
        pushLog(state, `Copying ${object.key}`, {
          itemId: item.id,
          stage,
          key: object.key,
          size: objectSize,
          kind: isMismatch ? "mismatched" : "missing",
        })
        let lastProgressAt = 0
        try {
          await copyObject(sourceClient, targetClient, item.sourceBucket, item.targetBucket, object.key, {
            onProgress: ({ loaded, total }) => {
              const now = Date.now()
              if (now - lastProgressAt < 800 && loaded < total) return
              lastProgressAt = now
              state.currentFile = {
                itemId: item.id,
                bucket: item.sourceBucket,
                key: object.key,
                size: objectSize,
                stage,
                status: "copying",
                startedAt,
                bytesTransferred: loaded,
                bytesTotal: total || objectSize,
                updatedAt: new Date().toISOString(),
              }
              upsertFileEvent(state, {
                itemId: item.id,
                bucket: item.sourceBucket,
                key: object.key,
                size: objectSize,
                kind: isMismatch ? "mismatched" : "missing",
                stage,
                status: "copying",
                startedAt,
                bytesTransferred: loaded,
                bytesTotal: total || objectSize,
              })
              syncLiveProgress()
            },
          })
          transferred += 1
          upsertFileEvent(state, {
            itemId: item.id,
            bucket: item.sourceBucket,
            key: object.key,
            size: objectSize,
            kind: isMismatch ? "mismatched" : "missing",
            stage,
            status: "copied",
            startedAt,
            completedAt: new Date().toISOString(),
            bytesTransferred: objectSize,
            bytesTotal: objectSize,
          })
          forceSyncLiveProgress()
        } catch (error) {
          failed += 1
          upsertFileEvent(state, {
            itemId: item.id,
            bucket: item.sourceBucket,
            key: object.key,
            size: objectSize,
            kind: isMismatch ? "mismatched" : "missing",
            stage,
            status: "failed",
            startedAt,
            completedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          })
          if (failureSamples.length < 25) {
            failureSamples.push({
              key: object.key,
              error: error instanceof Error ? error.message : String(error),
            })
          }
          pushLog(state, `Failed to copy ${object.key}`, {
            itemId: item.id,
            stage,
            key: object.key,
            error: error instanceof Error ? error.message : String(error),
          })
          forceSyncLiveProgress()
        }
        state.currentFile = null
        upsertItemProgress(state, {
          itemId: item.id,
          stage,
          status: "running",
          transferred,
          failed,
          skipped,
          processedFiles: transferred + failed,
          totalFiles: toRepair.length,
          summary: `Repairing ${item.sourceBucket}: ${transferred} copied, ${failed} failed, ${skipped} skipped`,
        })

        await safeUpdateJob(jobId, {
          status: "running",
          items: [
            {
              itemId: item.id,
              stage,
              status: "running",
              summary: `Repairing ${item.sourceBucket}: ${transferred} copied, ${failed} failed, ${skipped} skipped`,
              transferred,
              failed,
              skipped,
              details: {
                initialMissing,
                initialMismatched,
                attempted: transferred + failed,
                remaining: Math.max(0, toRepair.length - transferred - failed),
              },
            },
          ],
          progress: {
            ...buildTelemetryProgress(state, {
              currentItemId: item.id,
              stage,
              currentBucket: item.sourceBucket,
              transferred,
              failed,
              skipped,
              totals: buildLiveTotals(completedResults, {
                transferred,
                failed,
                skipped,
              }),
            }),
          },
        })
      }
    } else {
      skipped = toRepair.length
      upsertItemProgress(state, {
        itemId: item.id,
        stage: "repair_verify",
        status: "running",
        transferred,
        failed,
        skipped,
        processedFiles: toRepair.length,
        totalFiles: toRepair.length,
        summary: `Verify-only mode for ${item.sourceBucket}: ${toRepair.length} files queued for verification`,
      })
    }

    stage = "repair_verify"
    currentStageStartedAt = new Date().toISOString()
    pushLog(state, `Verifying ${item.sourceBucket}`, {
      itemId: item.id,
      stage,
      sourceCount: sourceObjects.length,
    })
    let finalDestinationObjects = await listAllObjects(targetClient, item.targetBucket, prefix)
    let finalDiff = diffObjectsByListing(sourceObjects, finalDestinationObjects, ({ checked, key, size, missing, mismatched }) => {
      state.currentFile = {
        itemId: item.id,
        bucket: item.sourceBucket,
        key: typeof key === "string" ? key : "",
        size: typeof size === "number" ? size : 0,
        stage,
        status: "verifying",
        startedAt: currentStageStartedAt,
        checkedObjects: checked,
        totalObjects: sourceObjects.length,
        missing,
        mismatched,
        updatedAt: new Date().toISOString(),
      }
      upsertItemProgress(state, {
        itemId: item.id,
        stage,
        status: "running",
        verifyCheckedCount: checked,
        finalMissing: missing,
        finalMismatched: mismatched,
        summary: `Verifying ${item.sourceBucket}: ${checked}/${sourceObjects.length} checked`,
      })
      syncLiveProgress({ verifyCheckedCount: checked, missing, mismatched })
    })
    let finalMissing = finalDiff.missing.length
    let finalMismatched = finalDiff.mismatched.length

    if ((finalMissing > 0 || finalMismatched > 0) && payload.job.mode !== "verify_only") {
      stage = "repair_reconcile"
      currentStageStartedAt = new Date().toISOString()
      const remainingToRepair = [...finalDiff.missing, ...finalDiff.mismatched]
      pushLog(state, `Final verify found remaining issues in ${item.sourceBucket}; retrying ${remainingToRepair.length} object(s)`, {
        itemId: item.id,
        stage,
        finalMissing,
        finalMismatched,
      })

      for (const object of remainingToRepair) {
        const isMismatch = typeof object?.destinationSize === "number"
        const objectSize = typeof object?.size === "number" ? object.size : 0
        const latestTargetSize = await getTargetObjectSize(targetClient, item.targetBucket, object.key)
        if (latestTargetSize === objectSize) {
          skipped += 1
          upsertFileEvent(state, {
            itemId: item.id,
            bucket: item.sourceBucket,
            key: object.key,
            size: objectSize,
            kind: isMismatch ? "mismatched" : "missing",
            stage,
            status: "skipped",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            bytesTransferred: objectSize,
            bytesTotal: objectSize,
          })
          continue
        }
        const startedAt = new Date().toISOString()
        state.currentFile = {
          itemId: item.id,
          bucket: item.sourceBucket,
          key: object.key,
          size: objectSize,
          stage,
          status: "copying",
          startedAt,
          bytesTransferred: 0,
          bytesTotal: objectSize,
        }
        upsertFileEvent(state, {
          itemId: item.id,
          bucket: item.sourceBucket,
          key: object.key,
          size: objectSize,
          kind: isMismatch ? "mismatched" : "missing",
          stage,
          status: "copying",
          startedAt,
          bytesTransferred: 0,
          bytesTotal: objectSize,
        })
        forceSyncLiveProgress()

        try {
          await copyObject(sourceClient, targetClient, item.sourceBucket, item.targetBucket, object.key, {
            onProgress: ({ loaded, total }) => {
              state.currentFile = {
                itemId: item.id,
                bucket: item.sourceBucket,
                key: object.key,
                size: objectSize,
                stage,
                status: "copying",
                startedAt,
                bytesTransferred: loaded,
                bytesTotal: total || objectSize,
                updatedAt: new Date().toISOString(),
              }
              upsertFileEvent(state, {
                itemId: item.id,
                bucket: item.sourceBucket,
                key: object.key,
                size: objectSize,
                kind: isMismatch ? "mismatched" : "missing",
                stage,
                status: "copying",
                startedAt,
                bytesTransferred: loaded,
                bytesTotal: total || objectSize,
              })
              syncLiveProgress()
            },
          })
          transferred += 1
          upsertFileEvent(state, {
            itemId: item.id,
            bucket: item.sourceBucket,
            key: object.key,
            size: objectSize,
            kind: isMismatch ? "mismatched" : "missing",
            stage,
            status: "copied",
            startedAt,
            completedAt: new Date().toISOString(),
            bytesTransferred: objectSize,
            bytesTotal: objectSize,
          })
          forceSyncLiveProgress()
        } catch (error) {
          failed += 1
          if (failureSamples.length < 25) {
            failureSamples.push({
              key: object.key,
              error: error instanceof Error ? error.message : String(error),
            })
          }
          upsertFileEvent(state, {
            itemId: item.id,
            bucket: item.sourceBucket,
            key: object.key,
            size: objectSize,
            kind: isMismatch ? "mismatched" : "missing",
            stage,
            status: "failed",
            startedAt,
            completedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          })
          forceSyncLiveProgress()
        }
      }

      state.currentFile = null
      finalDestinationObjects = await listAllObjects(targetClient, item.targetBucket, prefix)
      finalDiff = diffObjectsByListing(sourceObjects, finalDestinationObjects)
      finalMissing = finalDiff.missing.length
      finalMismatched = finalDiff.mismatched.length
    }

    const completed = finalMissing === 0 && finalMismatched === 0
    const resolvedAllObjects = completed && finalDestinationObjects.length >= sourceObjects.length
    state.stats.verifiedObjects += sourceObjects.length
    state.currentFile = null
    upsertItemProgress(state, {
      itemId: item.id,
      stage,
      status: completed ? "completed" : "failed",
      transferred,
      failed,
      skipped,
      processedFiles: Math.max(toRepair.length, transferred + failed + skipped),
      totalFiles: toRepair.length,
      initialMissing,
      initialMismatched,
      finalMissing,
      finalMismatched,
      summary: completed
        ? `Repair verified for ${item.sourceBucket}`
        : `Repair incomplete for ${item.sourceBucket}: ${finalMissing} missing, ${finalMismatched} mismatched`,
    })
    pushLog(
      state,
      completed
        ? `Repair verified for ${item.sourceBucket}`
        : `Repair incomplete for ${item.sourceBucket}`,
      {
        itemId: item.id,
        stage,
        finalMissing,
        finalMismatched,
      }
    )
    if (completed) state.stats.completedBuckets += 1
    else state.stats.failedBuckets += 1

    await safeUpdateJob(jobId, {
        status: "running",
        items: [
          {
            itemId: item.id,
            stage,
            status: completed ? "completed" : "failed",
            summary: completed
              ? `Repair verified for ${item.sourceBucket}`
              : `Repair incomplete for ${item.sourceBucket}: ${finalMissing} missing, ${finalMismatched} mismatched`,
            transferred,
            failed,
            skipped,
            details: {
              initialMissing,
              initialMismatched,
              sourceObjectCount: sourceObjects.length,
              sourceBytes,
              destinationObjectCountBefore: destinationObjects.length,
              destinationObjectCountAfter: finalDestinationObjects.length,
              finalMissing,
              finalMismatched,
              resolvedAllObjects,
              failureSamples,
            },
          },
        ],
        progress: {
          ...buildTelemetryProgress(state, {
            currentItemId: item.id,
            stage,
            currentBucket: item.sourceBucket,
            transferred,
            failed,
            skipped,
            finalMissing,
            finalMismatched,
            totals: buildLiveTotals(completedResults, {
              transferred,
              failed,
              skipped,
              missing: finalMissing,
              mismatched: finalMismatched,
            }),
          }),
        },
      })

    return {
      itemId: item.id,
      sourceBucket: item.sourceBucket,
      targetBucket: item.targetBucket,
      initialMissing,
      initialMismatched,
      sourceObjectCount: sourceObjects.length,
      sourceBytes,
      destinationObjectCountBefore: destinationObjects.length,
      destinationObjectCountAfter: finalDestinationObjects.length,
      transferred,
      failed,
      skipped,
      finalMissing,
      finalMismatched,
      completed,
      resolvedAllObjects,
      failureSamples,
    }
  } catch (error) {
    if (error instanceof JobAbortedError) throw error
    state.stats.failedBuckets += 1
    pushLog(state, `Worker ${stage.replace("repair_", "")} failed for ${item.sourceBucket}`, {
      itemId: item.id,
      stage,
      error: error instanceof Error ? error.message : String(error),
    })
    upsertItemProgress(state, {
      itemId: item.id,
      sourceBucket: item.sourceBucket,
      targetBucket: item.targetBucket,
      stage,
      status: "failed",
      transferred,
      failed,
      skipped,
      processedFiles: transferred + failed,
      summary: `Worker ${stage.replace("repair_", "")} failed for ${item.sourceBucket}`,
      error: error instanceof Error ? error.message : String(error),
    })
    if (state.currentFile?.itemId === item.id) {
      upsertFileEvent(state, {
        ...state.currentFile,
        itemId: item.id,
        key: state.currentFile.key,
        stage,
        status: "failed",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
      state.currentFile = null
    }
    await safeUpdateJob(jobId, {
      status: "running",
      items: [
        {
          itemId: item.id,
          stage,
          status: "failed",
          summary: `Worker ${stage.replace("repair_", "")} failed for ${item.sourceBucket}`,
          transferred,
          failed,
          skipped,
          details: {
            initialMissing,
            initialMismatched,
            failureSamples,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      ],
      progress: {
        ...buildTelemetryProgress(state, {
          currentItemId: item.id,
          currentBucket: item.sourceBucket,
          stage,
          transferred,
          failed,
          skipped,
          totals: buildLiveTotals(completedResults, {
            transferred,
            failed,
            skipped,
          }),
        }),
      },
    }).catch(() => {})
    throw error
  }
}

async function runJob(job, payload) {
  const state = createJobTelemetry(payload)
  pushLog(state, `Strict worker verification enabled across ${Array.isArray(payload?.items) ? payload.items.length : 0} bucket(s)`, {
    stage: "start",
    mode: payload?.job?.mode || "repair_and_verify",
    verifyAllBuckets: payload?.job?.verifyAllBuckets === true,
    strictCompletion: payload?.job?.strictCompletion === true,
  })
  const results = []
  for (const item of Array.isArray(payload.items) ? payload.items : []) {
    results.push(await processItem(job.id, payload, item, results, state))
  }

  const totalMissing = results.reduce((sum, item) => sum + item.finalMissing, 0)
  const totalMismatched = results.reduce((sum, item) => sum + item.finalMismatched, 0)
  const totalTransferred = results.reduce((sum, item) => sum + item.transferred, 0)
  const totalFailed = results.reduce((sum, item) => sum + item.failed, 0)
  const totalVerifiedObjects = results.reduce((sum, item) => sum + Number(item.sourceObjectCount || 0), 0)
  const completed = totalMissing === 0 && totalMismatched === 0 && totalFailed === 0
  pushLog(
    state,
    completed
      ? `Worker reconciliation completed: destination matches source across ${results.length} bucket(s); ${totalVerifiedObjects} objects verified, ${totalTransferred} repaired`
      : `Worker reconciliation incomplete: ${totalMissing} missing, ${totalMismatched} mismatched, ${totalFailed} copy failures`,
    {
      stage: "completed",
      transferred: totalTransferred,
      failed: totalFailed,
      missing: totalMissing,
      mismatched: totalMismatched,
      verifiedObjects: totalVerifiedObjects,
    }
  )

  await finalizeJobUpdate(job.id, {
    status: completed ? "completed" : "failed",
    summary: completed
      ? `Worker reconciliation completed: destination matches source across ${results.length} bucket(s); ${totalVerifiedObjects} objects verified, ${totalTransferred} repaired`
      : `Worker reconciliation incomplete: ${totalMissing} missing, ${totalMismatched} mismatched, ${totalFailed} copy failures`,
    error: completed ? null : "One or more items still have missing/mismatched files after worker repair",
    result: {
      items: results,
      logs: state.logs,
      fileEvents: state.fileEvents,
      itemProgress: state.itemProgress,
      totals: {
        transferred: totalTransferred,
        failed: totalFailed,
        skipped: results.reduce((sum, item) => sum + item.skipped, 0),
        missing: totalMissing,
        mismatched: totalMismatched,
        verifiedObjects: totalVerifiedObjects,
      },
    },
    progress: {
      ...buildTelemetryProgress(state, {
        stage: "completed",
        active: false,
        currentFile: null,
        totals: {
          transferred: totalTransferred,
          failed: totalFailed,
          skipped: results.reduce((sum, item) => sum + item.skipped, 0),
          missing: totalMissing,
          mismatched: totalMismatched,
          verifiedObjects: totalVerifiedObjects,
          completedItems: results.filter((item) => item.completed).length,
          failedItems: results.filter((item) => !item.completed).length,
        },
      }),
    },
  })
}

let currentJobId = null
let currentMigrationId = null

async function startHeartbeatLoop() {
  while (true) {
    try {
      await heartbeat(currentJobId ? { currentJobId } : {})
    } catch (error) {
      console.error("Heartbeat failed:", error instanceof Error ? error.message : String(error))
    }
    if (currentJobId) {
      try {
        await safeUpdateJob(currentJobId, {
          progress: { heartbeatAt: new Date().toISOString(), active: true },
        })
      } catch (error) {
        if (!(error instanceof JobAbortedError)) {
          console.error("Job heartbeat update failed:", error instanceof Error ? error.message : String(error))
        }
      }
    }
    await sleep(HEARTBEAT_MS)
  }
}

async function main() {
  console.log(`Worker starting for agent ${AGENT_ID} at ${SERVER_URL}`)
  void startHeartbeatLoop()

  while (true) {
    try {
      const claimed = await tryClaimJob()
      if (!claimed?.job || !claimed?.payload) {
        await sleep(POLL_MS)
        continue
      }

      currentJobId = claimed.job.id
      currentMigrationId = claimed.payload?.migration?.id || null
      migrationItemProgressCache.clear()
      repairJobProgressCache.clear()
      console.log(`Claimed job ${claimed.job.id} for migration ${claimed.payload?.migration?.id || "-"}`)
      await runJob(claimed.job, claimed.payload)
      console.log(`Finished job ${claimed.job.id}`)
      currentJobId = null
      currentMigrationId = null
      migrationItemProgressCache.clear()
      repairJobProgressCache.clear()
      if (EXIT_AFTER_JOB) {
        console.log(`Exit-after-job enabled; stopping worker after job ${claimed.job.id}`)
        return
      }
    } catch (error) {
      console.error("Worker loop error:", error instanceof Error ? error.message : String(error))
      const failedJobId = currentJobId
      if (currentJobId) {
        if (error instanceof JobAbortedError) {
          console.log(`Job ${currentJobId} aborted by user`)
        } else {
          try {
            await finalizeJobUpdate(currentJobId, {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
              summary: "Worker crashed while processing repair job",
            })
          } catch {}
        }
      }
      currentJobId = null
      currentMigrationId = null
      migrationItemProgressCache.clear()
      repairJobProgressCache.clear()
      if (EXIT_AFTER_JOB && failedJobId) {
        console.log(`Exit-after-job enabled; stopping worker after terminal job ${failedJobId}`)
        return
      }
      await sleep(POLL_MS)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
