import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { Client as PostgresClient } from "pg"
import { createHash, randomUUID } from "crypto"
import { mkdir, readFile, rename, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { Transform } from "stream"

function getArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return process.env[name.toUpperCase().replace(/-/g, "_")] || fallback
}

let SERVER_URL = String(getArg("server-url", "")).replace(/\/+$/, "")
let AGENT_ID = String(getArg("agent-id", "")).trim()
let AGENT_TOKEN = String(getArg("token", ""))
const MIGRATION_ID = String(getArg("migration-id", process.env.DRIVE_MIGRATION_ID || process.env.MIGRATION_ID || ""))
const REPAIR_JOB_ID = String(getArg("repair-job-id", process.env.DRIVE_REPAIR_JOB_ID || ""))
const POOL_MODE = Boolean(MIGRATION_ID && !REPAIR_JOB_ID)
const GITHUB_RUN_ID = String(process.env.GITHUB_RUN_ID || "")
const WORKER_INSTANCE_ID = String(process.env.WORKER_INSTANCE_ID || GITHUB_RUN_ID || "").trim()
// Persistent workers immediately claim again after every completed file. When
// the scanner is still producing inventory pages, a one-second idle poll
// bounds hand-off latency without letting large worker pools hammer Postgres.
const POLL_MS = Math.max(500, Number(getArg("poll-ms", "1000")) || 1_000)
const HEARTBEAT_MS = Math.max(10_000, Number(getArg("heartbeat-ms", "20000")) || 20_000)
const MAX_OBJECTS = Math.max(1, Math.min(10_000_000, Number(getArg("max-objects", "2000000")) || 2_000_000))
const API_TIMEOUT_MS = Math.max(5_000, Number(getArg("api-timeout-ms", "30000")) || 30_000)
const API_RETRIES = Math.max(1, Math.min(6, Number(getArg("api-retries", "3")) || 3))
const S3_RETRIES = Math.max(1, Math.min(6, Number(getArg("s3-retries", "3")) || 3))
const COPY_CONCURRENCY = Math.max(1, Math.min(64, Number(getArg("copy-concurrency", "8")) || 8))
const UPLOAD_QUEUE_SIZE = Math.max(1, Math.min(16, Number(getArg("upload-queue-size", "4")) || 4))
const UPLOAD_PART_SIZE = Math.max(
  5 * 1024 * 1024,
  Math.min(128 * 1024 * 1024, (Number(getArg("upload-part-size-mb", "16")) || 16) * 1024 * 1024)
)
const RANGE_COPY_THRESHOLD_MB = Number(getArg("range-copy-threshold-mb", "64"))
const RANGE_COPY_THRESHOLD = Math.max(
  0,
  Math.min(1024 * 1024 * 1024, (Number.isFinite(RANGE_COPY_THRESHOLD_MB) ? RANGE_COPY_THRESHOLD_MB : 64) * 1024 * 1024)
)
const RANGE_COPY_CONCURRENCY = Math.max(1, Math.min(16, Number(getArg("range-copy-concurrency", String(UPLOAD_QUEUE_SIZE))) || UPLOAD_QUEUE_SIZE))
// Keep one heartbeat cycle well below the panel's stale-lease window. A
// 60-second timeout with five retries can block for several minutes, causing
// the orchestrator to requeue a live worker while it is still copying.
const HEARTBEAT_TIMEOUT_MS = Math.max(5_000, Math.min(API_TIMEOUT_MS, 15_000))
const HEARTBEAT_RETRIES = Math.max(2, Math.min(API_RETRIES, 3))
const SUPABASE_TIMEOUT_MS = Math.max(1_000, Number(getArg("supabase-timeout-ms", "5000")) || 5_000)
const DEFAULT_EXIT_AFTER_JOB = POOL_MODE ? "false" : process.env.GITHUB_ACTIONS === "true" ? "true" : "false"
const EXIT_AFTER_JOB = ["1", "true", "yes"].includes(
  String(getArg("exit-after-job", DEFAULT_EXIT_AFTER_JOB)).toLowerCase()
)
const SUPABASE_URL = String(getArg("supabase-url", process.env.NEXT_PUBLIC_SUPABASE_URL || ""))
const SUPABASE_SERVICE_ROLE_KEY = String(getArg("supabase-service-role-key", ""))
const POSTGRES_URL = String(getArg("postgres-url", ""))
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null
const migrationItemProgressCache = new Map()
const repairJobProgressCache = new Map()
const jobAbortControllers = new Map()
const jobUpdateQueues = new Map()
const jobClaimTokens = new Map()
let runtimeConfigurationLoadedAt = 0
const WORKER_STATE_DIR = path.resolve(String(getArg("state-dir", path.join(process.cwd(), ".drive-worker"))))
const WORKER_IDENTITY_PATH = path.join(WORKER_STATE_DIR, "identity.json")

if (!SERVER_URL || AGENT_TOKEN.length < 24) {
  console.error("Missing required configuration. Provide SERVER_URL and TOKEN (the common Migration Worker secret).")
  process.exit(1)
}

async function postgres(operation) {
  if (!POSTGRES_URL) throw new Error("POSTGRES_URL is not configured")
  const hostname = new URL(POSTGRES_URL).hostname
  const client = new PostgresClient({ connectionString: POSTGRES_URL, ssl: ["localhost", "127.0.0.1"].includes(hostname) ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 })
  await client.connect()
  try { return await operation(client) } finally { await client.end().catch(() => undefined) }
}

async function loadRuntimeConfiguration(force = false) {
  if (!force && runtimeConfigurationLoadedAt > Date.now() - 60_000) return
  if (!SERVER_URL || AGENT_TOKEN.length < 24) throw new Error("SERVER_URL and the common Migration Worker secret are required")
  runtimeConfigurationLoadedAt = Date.now()
}

function validUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

async function readIdentity() {
  try {
    const parsed = JSON.parse(await readFile(WORKER_IDENTITY_PATH, "utf8"))
    if (!validUuid(parsed?.instanceId)) return null
    return { instanceId: parsed.instanceId, agentId: validUuid(parsed.agentId) ? parsed.agentId : "" }
  } catch {
    return null
  }
}

async function getOrCreateIdentity() {
  const existing = await readIdentity()
  if (existing) return existing
  await mkdir(WORKER_STATE_DIR, { recursive: true, mode: 0o700 })
  const identity = { instanceId: randomUUID(), agentId: "" }
  try {
    // Exclusive creation makes concurrent starts in one state directory share
    // one durable instance identity instead of creating duplicate workers.
    await writeFile(WORKER_IDENTITY_PATH, `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    return identity
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
    const winner = await readIdentity()
    if (!winner) throw new Error(`Worker identity at ${WORKER_IDENTITY_PATH} is invalid`)
    return winner
  }
}

async function persistIdentity(identity) {
  await mkdir(WORKER_STATE_DIR, { recursive: true, mode: 0o700 })
  const temporary = `${WORKER_IDENTITY_PATH}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, WORKER_IDENTITY_PATH)
}

async function ensureWorkerIdentity() {
  if (AGENT_ID) return
  const identity = await getOrCreateIdentity()
  const response = await withRetries(
    "register worker instance",
    () => fetch(`${SERVER_URL}/workers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        token: AGENT_TOKEN,
        instanceId: identity.instanceId,
        agentId: identity.agentId || undefined,
        name: `${os.hostname()} migration worker`,
        host: os.hostname(),
        version: "worker-v3",
        capabilities: ["scan", "verify", "repair", "bulk_migrate", "diagnostics"],
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    }),
    API_RETRIES
  )
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !validUuid(payload?.agentId)) {
    throw new Error(payload?.error || `Worker registration failed with HTTP ${response.status}`)
  }
  AGENT_ID = payload.agentId
  if (identity.agentId !== AGENT_ID) await persistIdentity({ ...identity, agentId: AGENT_ID })
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

function normalizeWorkerShard(value) {
  if (!isRecord(value)) return null
  const index = Number(value.index)
  const count = Number(value.count)
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) return null
  return { index, count }
}

function requiresWorkerShard(payload) {
  return payload?.job?.kind === "migration_shard"
}

// FNV-1a gives every object a stable owner shard. The namespace includes the
// source bucket so identical keys in different buckets remain independent.
function objectBelongsToShard(object, namespace, shard) {
  if (!shard || shard.count <= 1) return true
  const value = `${String(namespace || "")}\u0000${String(object?.key || "")}`
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % shard.count === shard.index
}

function filterObjectsForShard(objects, namespace, shard) {
  if (!shard || shard.count <= 1) return objects
  return objects.filter((object) => objectBelongsToShard(object, namespace, shard))
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
  const status = Number(error?.$metadata?.httpStatusCode || error?.status || 0)
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
      if (error instanceof JobAbortedError) throw error
      if (attempt >= retries || !isRetryableError(error)) throw error
      await sleep(Math.min(5000, 400 * 2 ** (attempt - 1)))
    }
  }
  throw lastError || new Error(`${label} failed`)
}

async function runConcurrent(items, concurrency, worker) {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      await worker(items[index], index)
    }
  })
  // Wait for every in-flight task before propagating a failure. Promise.all
  // rejects immediately and would otherwise let copies from this job continue
  // in the background while the lease is being finalized or requeued.
  const settled = await Promise.allSettled(workers)
  const failure = settled.find((entry) => entry.status === "rejected")
  if (failure?.status === "rejected") throw failure.reason
}

class JobAbortedError extends Error {
  constructor(message = "Worker job aborted by user") {
    super(message)
    this.name = "JobAbortedError"
  }
}

function markJobAborted(jobId) {
  const controller = jobAbortControllers.get(jobId)
  if (controller && !controller.signal.aborted) controller.abort()
}

function getJobAbortSignal(jobId) {
  return jobAbortControllers.get(jobId)?.signal
}

function throwIfJobAborted(jobId) {
  if (getJobAbortSignal(jobId)?.aborted) throw new JobAbortedError()
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
          const requestError = new Error(message)
          requestError.status = response.status
          throw requestError
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
  let response = null
  let directRequired = Boolean(POSTGRES_URL)
  if (!directRequired) {
    try {
      response = await api(
        `/workers/${encodeURIComponent(AGENT_ID)}/heartbeat`,
        { token: AGENT_TOKEN, host: os.hostname(), version: "worker-v2", capabilities: ["scan", "verify", "repair", "bulk_migrate", "diagnostics"], metadata: { ...extra, workerInstanceId: WORKER_INSTANCE_ID || undefined } },
        { timeoutMs: HEARTBEAT_TIMEOUT_MS, retries: HEARTBEAT_RETRIES }
      )
    } catch (error) {
      if ((!POSTGRES_URL && !supabase) || !isRetryableError(error)) throw error
      directRequired = true
      console.warn("Panel heartbeat unavailable; syncing directly through the orchestration database")
    }
  }

  if (directRequired && POSTGRES_URL) {
    await loadRuntimeConfiguration()
    await postgres(async (db) => {
      const auth = await db.query(`select a.id,a.status,s.value->>'sharedSecret' secret from drive_agents a left join drive_app_settings s on s.key='migration-workers' where a.id=$1 limit 1`, [AGENT_ID])
      const row = auth.rows[0]
      if (!row || row.status === "disabled" || row.secret !== AGENT_TOKEN) throw new Error("Worker is missing, disabled, or has an invalid shared secret")
      await db.query(`update drive_agents set status='online',last_heartbeat_at=now(),last_seen_host=$2,last_seen_version='worker-v2',metadata=coalesce(metadata,'{}'::jsonb)||$3::jsonb,updated_at=now() where id=$1 and status<>'disabled'`, [AGENT_ID, os.hostname(), JSON.stringify(extra)])
      if (WORKER_INSTANCE_ID) {
        await db.query(`update drive_agent_runs set status='running',updated_at=now() where agent_id=$1 and payload->>'workerInstanceId'=$2 and status in('pending','running')`, [AGENT_ID, WORKER_INSTANCE_ID])
      }
      if (currentJobId) {
        const renewed = await db.query(`update drive_repair_jobs set last_heartbeat_at=now(),updated_at=now() where id=$1 and claimed_by_agent_id=$2 and ($3::uuid is null or claim_token=$3::uuid) and status in('claimed','running') returning id`, [currentJobId, AGENT_ID, jobClaimTokens.get(currentJobId) || null])
        if (!renewed.rowCount) throw new Error("This job lease is no longer owned by this worker")
      }
    })
    return { ok: true, direct: true }
  }

  if (supabase) {
    const currentAgent = await withTimeout(
      "supabase load worker metadata",
      supabase.from("drive_agents").select("metadata").eq("id", AGENT_ID).limit(1)
    ).catch(() => ({ data: null }))
    const currentAgentRow = currentAgent && typeof currentAgent === "object" && Array.isArray(currentAgent.data)
      ? currentAgent.data[0]
      : null
    const currentMetadata = isRecord(currentAgentRow?.metadata) ? currentAgentRow.metadata : {}
    const heartbeatResult = await withTimeout(
      "supabase worker heartbeat",
      supabase
        .from("drive_agents")
        .update({
          status: "online",
          last_heartbeat_at: new Date().toISOString(),
          last_seen_host: os.hostname(),
          last_seen_version: "worker-v2",
          metadata: { ...currentMetadata, ...extra },
          updated_at: new Date().toISOString(),
        })
        .eq("id", AGENT_ID)
    ).catch((error) => ({ error }))
    if (directRequired && heartbeatResult?.error) {
      throw new Error(heartbeatResult.error?.message || "Direct worker heartbeat failed")
    }
  }
  return response || { ok: true, direct: true }
}

async function claimJob() {
  await loadRuntimeConfiguration()
  if (POSTGRES_URL) return claimJobDirectPostgres()
  try {
    return await api(`/workers/${encodeURIComponent(AGENT_ID)}/claim-job`, {
      token: AGENT_TOKEN,
      ...(MIGRATION_ID ? { migrationId: MIGRATION_ID } : {}),
      ...(POOL_MODE ? { pool: true } : {}),
      ...(REPAIR_JOB_ID ? { jobId: REPAIR_JOB_ID } : {}),
      ...(GITHUB_RUN_ID ? { githubRunId: GITHUB_RUN_ID } : {}),
      ...(WORKER_INSTANCE_ID ? { workerInstanceId: WORKER_INSTANCE_ID } : {}),
    })
  } catch (error) {
    if ((!POSTGRES_URL && !supabase) || !isRetryableError(error)) throw error
    console.warn("Panel claim unavailable; claiming a fenced shard directly from the orchestration database")
    return POSTGRES_URL ? claimJobDirectPostgres() : claimJobDirect()
  }
}

async function claimJobDirectPostgres() {
  if (!MIGRATION_ID) throw new Error("Direct autonomous claim requires migrationId")
  return postgres(async (db) => {
    const auth = await db.query(`
      select a.status agent_status,a.capabilities,m.*,m.status migration_status,s.value->>'sharedSecret' worker_secret,
        jsonb_build_object('cloudflare_account_id',sa.cloudflare_account_id,'r2_access_key_id',sa.r2_access_key_id,'r2_secret_access_key',sa.r2_secret_access_key) source_account,
        jsonb_build_object('cloudflare_account_id',ta.cloudflare_account_id,'r2_access_key_id',ta.r2_access_key_id,'r2_secret_access_key',ta.r2_secret_access_key) target_account
      from drive_agents a cross join drive_migrations m
      join drive_accounts sa on sa.id=m.source_account_id join drive_accounts ta on ta.id=m.target_account_id
      left join drive_app_settings s on s.key='migration-workers'
      where a.id=$1 and m.id=$2 limit 1
    `, [AGENT_ID, MIGRATION_ID])
    const migration = auth.rows[0]
    if (!migration || migration.agent_status === "disabled" || migration.worker_secret !== AGENT_TOKEN) throw new Error("Worker is missing, disabled, or has an invalid shared secret")
    if (!Array.isArray(migration.capabilities) || !migration.capabilities.includes("bulk_migrate")) throw new Error("Worker is not registered for bulk migrations")
    if (migration.options?.executionMode !== "migration_workers") throw new Error("Direct claim requires a migration worker migration")
    if (["completed", "failed", "canceled"].includes(migration.migration_status)) return { ok: true, job: null, poolComplete: true, poolStatus: migration.migration_status }
    const generation = Math.max(1, Math.trunc(Number(migration.options?.workerGeneration) || 1))
    const claimed = await db.query(`
      with candidate as (
        select id from drive_repair_jobs where migration_id=$1 and status='pending' and claimed_by_agent_id is null
          and work_key like $2 order by created_at for update skip locked limit 1
      )
      update drive_repair_jobs j set status='running',claimed_by_agent_id=$3,claim_token=gen_random_uuid(),claimed_at=now(),started_at=coalesce(started_at,now()),last_heartbeat_at=now(),summary='Claimed directly through PostgreSQL',payload=coalesce(j.payload,'{}'::jsonb)||jsonb_build_object('claimedWorkerInstanceId',$4::text),updated_at=now()
      from candidate c where j.id=c.id returning j.*
    `, [MIGRATION_ID, `migration:${MIGRATION_ID}:generation:${generation}:inventory:%`, AGENT_ID, WORKER_INSTANCE_ID || null])
    const job = claimed.rows[0]
    if (!job) return { ok: true, job: null }
    if (WORKER_INSTANCE_ID) await db.query(`update drive_agent_runs set job_reference=$2,status='running',updated_at=now() where agent_id=$1 and payload->>'workerInstanceId'=$3 and status in('pending','running')`, [AGENT_ID, job.id, WORKER_INSTANCE_ID])
    jobClaimTokens.set(job.id, String(job.claim_token || ""))
    const items = await db.query(`select * from drive_migration_items where migration_id=$1 order by created_at`, [MIGRATION_ID])
    const requested = new Set(Array.isArray(job.payload?.itemIds) ? job.payload.itemIds : [])
    const selected = requested.size ? items.rows.filter((item) => requested.has(item.id)) : items.rows
    const source = migration.source_account; const target = migration.target_account
    const payload = {
      job: { id: job.id, mode: job.mode, migrationId: MIGRATION_ID, verifyAllBuckets: true, strictCompletion: true, kind: job.payload?.kind, progress: job.progress || {} },
      ...(isRecord(job.payload?.workerShard) ? { workerShard: job.payload.workerShard } : {}),
      ...(typeof job.payload?.workerGeneration === "number" ? { workerGeneration: job.payload.workerGeneration } : {}),
      ...(Array.isArray(job.payload?.inventoryObjects) ? { inventoryObjects: job.payload.inventoryObjects } : {}),
      migration: { id: MIGRATION_ID, options: migration.options || {}, pathPrefix: migration.options?.pathPrefix || null },
      source: { accountId: source.cloudflare_account_id, accessKeyId: source.r2_access_key_id, secretAccessKey: source.r2_secret_access_key },
      target: { accountId: target.cloudflare_account_id, accessKeyId: target.r2_access_key_id, secretAccessKey: target.r2_secret_access_key },
      items: selected.map((item) => ({ id: item.id, sourceBucket: item.source_bucket, targetBucket: item.target_bucket, sourceObjects: Number(item.source_objects || 0), sourceBytes: Number(item.source_bytes || 0), slurperStatus: item.slurper_status, progress: item.progress || {} })),
    }
    return { ok: true, job: { id: job.id, migrationId: MIGRATION_ID, mode: job.mode, payload: job.payload || {} }, payload, direct: true }
  })
}

async function supabaseRows(label, query) {
  const result = await withTimeout(label, query)
  if (result?.error) throw new Error(result.error.message || `${label} failed`)
  return Array.isArray(result?.data) ? result.data : []
}

async function authenticateDirectWorker() {
  const [agents, settings] = await Promise.all([
    supabaseRows("load direct worker", supabase.from("drive_agents").select("*").eq("id", AGENT_ID).limit(1)),
    supabaseRows("load shared worker secret", supabase.from("drive_app_settings").select("value").eq("key", "migration-workers").limit(1)),
  ])
  const agent = agents[0]
  const configuredSecret = String(settings[0]?.value?.sharedSecret || "")
  if (!agent || agent.status === "disabled") throw new Error("Worker is missing or disabled")
  if (configuredSecret.length < 24 || configuredSecret.length > 512 || configuredSecret !== AGENT_TOKEN) throw new Error("Invalid shared worker secret")
  if (!Array.isArray(agent.capabilities) || !agent.capabilities.includes("bulk_migrate")) throw new Error("Worker is not registered for bulk migrations")
  return agent
}

async function claimJobDirect() {
  await authenticateDirectWorker()
  if (!MIGRATION_ID) throw new Error("Direct autonomous claim requires migrationId")
  const migrations = await supabaseRows("load direct migration", supabase.from("drive_migrations").select("*").eq("id", MIGRATION_ID).limit(1))
  const migration = migrations[0]
  if (!migration || migration.options?.executionMode !== "migration_workers") throw new Error("Direct claim requires a migration worker migration")
  if (["completed", "failed", "canceled"].includes(migration.status)) return { ok: true, job: null, poolComplete: true, poolStatus: migration.status }

  const candidates = await supabaseRows(
    "find pending autonomous shard",
    supabase.from("drive_repair_jobs").select("*").eq("migration_id", MIGRATION_ID).eq("status", "pending").order("created_at", { ascending: true }).limit(8)
  )
  let job = null
  for (const candidate of candidates) {
    if (!String(candidate.work_key || "").startsWith(`migration:${MIGRATION_ID}:generation:${Math.max(1, Math.trunc(Number(migration.options?.workerGeneration) || 1))}:inventory:`)) continue
    const claimed = await supabaseRows(
      `claim autonomous shard ${candidate.id}`,
      supabase.from("drive_repair_jobs").update({
        status: "running", claimed_by_agent_id: AGENT_ID, claimed_at: new Date().toISOString(), started_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(), summary: "Claimed directly through orchestration database", updated_at: new Date().toISOString(),
        payload: { ...(isRecord(candidate.payload) ? candidate.payload : {}), claimedWorkerInstanceId: WORKER_INSTANCE_ID || null },
      }).eq("id", candidate.id).eq("status", "pending").is("claimed_by_agent_id", null).select("*")
    )
    if (claimed[0]) { job = claimed[0]; break }
  }
  if (!job) return { ok: true, job: null }

  const requested = new Set(Array.isArray(job.payload?.itemIds) ? job.payload.itemIds : [])
  const [items, sourceAccounts, targetAccounts] = await Promise.all([
    supabaseRows("load direct migration items", supabase.from("drive_migration_items").select("*").eq("migration_id", MIGRATION_ID).order("created_at", { ascending: true })),
    supabaseRows("load direct source account", supabase.from("drive_accounts").select("*").eq("id", migration.source_account_id).limit(1)),
    supabaseRows("load direct target account", supabase.from("drive_accounts").select("*").eq("id", migration.target_account_id).limit(1)),
  ])
  const source = sourceAccounts[0]; const target = targetAccounts[0]
  if (!source?.cloudflare_account_id || !target?.cloudflare_account_id) throw new Error("Source or target account is incomplete")
  const selectedItems = requested.size ? items.filter((item) => requested.has(item.id)) : items
  const payload = {
    job: { id: job.id, mode: job.mode, migrationId: MIGRATION_ID, verifyAllBuckets: true, strictCompletion: true, kind: job.payload?.kind, progress: job.progress || {} },
    ...(isRecord(job.payload?.workerShard) ? { workerShard: job.payload.workerShard } : {}),
    ...(typeof job.payload?.workerGeneration === "number" ? { workerGeneration: job.payload.workerGeneration } : {}),
    ...(Array.isArray(job.payload?.inventoryObjects) ? { inventoryObjects: job.payload.inventoryObjects } : {}),
    migration: { id: MIGRATION_ID, options: migration.options || {}, pathPrefix: migration.options?.pathPrefix || null },
    source: { accountId: source.cloudflare_account_id, accessKeyId: source.r2_access_key_id, secretAccessKey: source.r2_secret_access_key },
    target: { accountId: target.cloudflare_account_id, accessKeyId: target.r2_access_key_id, secretAccessKey: target.r2_secret_access_key },
    items: selectedItems.map((item) => ({ id: item.id, sourceBucket: item.source_bucket, targetBucket: item.target_bucket, sourceObjects: Number(item.source_objects || 0), sourceBytes: Number(item.source_bytes || 0), slurperStatus: item.slurper_status, progress: item.progress || {} })),
  }
  return { ok: true, job: { id: job.id, migrationId: MIGRATION_ID, mode: job.mode, payload: job.payload || {} }, payload, direct: true }
}

async function updateMigrationItemLocal(migrationId, repairJobId, itemUpdate) {
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
  const slurper = [
    currentProgress.slurperCumulative,
    currentProgress.slurperNormalized,
    isRecord(currentProgress.slurper) ? currentProgress.slurper.result : null,
  ].find(isRecord)
  const slurperTransferred = typeof slurper?.transferredObjects === "number" ? slurper.transferredObjects : 0
  const slurperSkipped = typeof slurper?.skippedObjects === "number" ? slurper.skippedObjects : 0
  const sameRepairJob = repair.jobId === repairJobId
  const baselineTransferred = sameRepairJob
    ? typeof repair.baselineTransferred === "number"
      ? repair.baselineTransferred
      : 0
    : typeof repair.cumulativeTransferred === "number"
      ? repair.cumulativeTransferred
      : Math.max(0, typeof live.transferredObjects === "number" ? live.transferredObjects - slurperTransferred : 0)
  const baselineSkipped = sameRepairJob
    ? typeof repair.baselineSkipped === "number"
      ? repair.baselineSkipped
      : 0
    : typeof repair.cumulativeSkipped === "number"
      ? repair.cumulativeSkipped
      : Math.max(0, typeof live.skippedObjects === "number" ? live.skippedObjects - slurperSkipped : 0)
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
  const currentTransferred = typeof transferred === "number" ? transferred : sameRepairJob && typeof repair.transferred === "number" ? repair.transferred : 0
  const currentSkipped = typeof skipped === "number" ? skipped : sameRepairJob && typeof repair.skipped === "number" ? repair.skipped : 0
  const cumulativeTransferred = baselineTransferred + currentTransferred
  const cumulativeSkipped = Math.max(baselineSkipped, currentSkipped)

  const nextRepair = {
    ...repair,
    jobId: repairJobId,
    baselineTransferred,
    baselineSkipped,
    cumulativeTransferred,
    cumulativeSkipped,
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
        sourceObjectCount > 0
          ? Math.min(sourceObjectCount, slurperTransferred + cumulativeTransferred)
          : slurperTransferred + cumulativeTransferred,
      skippedObjects: Math.max(slurperSkipped, cumulativeSkipped),
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
      repairJobId,
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
  let persistLocally = null
  const persistPostgres = POSTGRES_URL
    ? async () => postgres(async (db) => {
        const status = typeof body.status === "string" ? body.status : null
        const completed = ["completed", "failed", "canceled"].includes(status)
        const result = await db.query(`
          update drive_repair_jobs set
            status=coalesce($3,status),progress=coalesce(progress,'{}'::jsonb)||$4::jsonb,result=coalesce(result,'{}'::jsonb)||$5::jsonb,
            summary=case when $6::text is null then summary else $6 end,error=case when $7::text is null then error else $7 end,
            last_heartbeat_at=now(),completed_at=case when $8::boolean then now() else completed_at end,updated_at=now()
          where id=$1 and claimed_by_agent_id=$2 and ($9::uuid is null or claim_token=$9::uuid) and status in('claimed','running') returning id
        `, [jobId, AGENT_ID, status, JSON.stringify(isRecord(body.progress) ? body.progress : {}), JSON.stringify(isRecord(body.result) ? body.result : {}), typeof body.summary === "string" ? body.summary : null, typeof body.error === "string" ? body.error : null, completed, jobClaimTokens.get(jobId) || null])
        if (!result.rowCount) throw new Error("This job lease is no longer owned by this worker")
      })
    : null
  if (jobClaimTokens.has(jobId) && persistPostgres) {
    await persistPostgres()
    if (["completed", "failed", "canceled"].includes(String(body.status || ""))) jobClaimTokens.delete(jobId)
    return { ok: true, direct: true }
  }
  if (supabase) {
    const status = typeof body.status === "string" ? body.status : undefined
    const progress = body.progress && typeof body.progress === "object" ? body.progress : undefined
    const result = body.result && typeof body.result === "object" ? body.result : undefined
    const summary = typeof body.summary === "string" ? body.summary : undefined
    const error = typeof body.error === "string" ? body.error : undefined
    const now = new Date().toISOString()
    persistLocally = async () => {
      // The API endpoint fences updates by claimed agent id. Keep the direct
      // Supabase fallback under the same lease fence so an offline worker
      // cannot overwrite a shard after the orchestrator requeues it.
      const selectResult = await withTimeout(
        `supabase load repair job ${jobId}`,
        supabase
          .from("drive_repair_jobs")
          .select("status, claimed_by_agent_id, migration_id, progress, result")
          .eq("id", jobId)
          .limit(1)
      ).catch(() => ({ data: null }))
      const data = selectResult && typeof selectResult === "object" ? selectResult.data : null
      const currentRow = Array.isArray(data) ? data[0] : null
      if (
        !currentRow ||
        currentRow.claimed_by_agent_id !== AGENT_ID ||
        !["claimed", "running"].includes(String(currentRow.status || ""))
      ) {
        return
      }

      const currentProgress = isRecord(currentRow?.progress) ? currentRow.progress : {}
      const currentResult = isRecord(currentRow?.result) ? currentRow.result : {}
      const mergedProgress = progress ? { ...currentProgress, ...progress } : undefined
      const mergedResult = result ? { ...currentResult, ...result } : undefined

      const persisted = await withTimeout(
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
          .eq("claimed_by_agent_id", AGENT_ID)
          .in("status", ["claimed", "running"])
          .select("id")
      ).catch(() => null)
      if (!persisted || persisted.error || !Array.isArray(persisted.data) || persisted.data.length === 0) return

      if (currentMigrationId && Array.isArray(body.items)) {
        for (const itemUpdate of body.items) {
          await updateMigrationItemLocal(currentMigrationId, jobId, itemUpdate).catch(() => undefined)
        }
      }

      if (currentMigrationId && (status === "completed" || status === "failed" || status === "canceled")) {
        await updateMigrationLocal(currentMigrationId, body).catch(() => undefined)
      }

      repairJobProgressCache.set(jobId, {
        progress: mergedProgress || currentProgress,
        result: mergedResult || currentResult,
      })
    }
  }
  let response
  try {
    response = await api(`/workers/${encodeURIComponent(AGENT_ID)}/jobs/${encodeURIComponent(jobId)}`, {
      token: AGENT_TOKEN,
      ...body,
    })
  } catch (error) {
    if (allowOffline && !(error instanceof JobAbortedError) && isRetryableError(error)) {
      if (persistPostgres) await persistPostgres()
      else if (persistLocally) await persistLocally()
      else throw error
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
  // Progress is best-effort. Keep at most one request in flight per job and
  // replace stale queued telemetry with the newest snapshot. Without this,
  // a panel outage creates dozens of concurrent retries and can delay the
  // terminal update long after the object work has finished.
  const existing = jobUpdateQueues.get(jobId)
  if (existing) {
    existing.pending = body
    return existing.promise
  }

  const state = { pending: body, promise: null }
  state.promise = (async () => {
    let response = null
    while (state.pending) {
      const nextBody = state.pending
      state.pending = null
      try {
        response = await updateJob(jobId, nextBody, { allowOffline: true })
        if (response?.offline) {
          console.error(`Job sync deferred for ${jobId}: ${response.error}`)
          // Drop stale telemetry after an outage. The next heartbeat/progress
          // tick will start one fresh bounded attempt if connectivity returns.
          state.pending = null
          break
        }
      } catch (error) {
        if (error instanceof JobAbortedError) {
          markJobAborted(jobId)
          return { canceled: true }
        }
        if (error instanceof Error && /no longer owned|claimed by another worker/i.test(error.message)) {
          // The orchestrator reclaimed this lease. Fence the old process before it
          // can report progress or intentionally retry the same object set.
          markJobAborted(jobId)
          return { canceled: true, fenced: true }
        }
        const message = error instanceof Error ? error.message : String(error)
        console.error(`Job sync failed for ${jobId}:`, message)
        return { offline: true, error: message }
      }
    }
    return response
  })()
  jobUpdateQueues.set(jobId, state)
  try {
    return await state.promise
  } finally {
    if (jobUpdateQueues.get(jobId) === state) jobUpdateQueues.delete(jobId)
  }
}

async function flushJobUpdates(jobId) {
  const state = jobUpdateQueues.get(jobId)
  if (state) await state.promise.catch(() => undefined)
}

async function finalizeJobUpdate(jobId, body) {
  await flushJobUpdates(jobId)
  try {
    const response = await updateJob(jobId, body, { allowOffline: true })
    if (response?.offline) {
      console.error(`Final job update deferred for ${jobId}: ${response.error}`)
    }
    return response
  } catch (error) {
    if (error instanceof JobAbortedError) return { canceled: true }
    if (error instanceof Error && /no longer owned|claimed by another worker/i.test(error.message)) {
      markJobAborted(jobId)
      return { canceled: true, fenced: true }
    }
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
  const seenKeys = new Set()
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
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      const size = typeof object?.Size === "number" ? object.Size : 0
      objects.push({ key, size, etag: typeof object?.ETag === "string" ? object.ETag.replace(/^\"|\"$/g, "") : null })
      if (typeof onProgress === "function") onProgress({ count: objects.length, key, size })
      if (objects.length > MAX_OBJECTS) {
        throw new Error(
          `Object inventory for ${bucket} exceeds MAX_OBJECTS=${MAX_OBJECTS}. Increase MAX_OBJECTS and retry; refusing to mark a truncated migration complete.`
        )
      }
    }
    const nextContinuationToken = typeof page.NextContinuationToken === "string" ? page.NextContinuationToken : undefined
    if (page.IsTruncated === true && !nextContinuationToken) {
      throw new Error(`Object inventory pagination ended without a continuation token for ${bucket}`)
    }
    continuationToken = nextContinuationToken
    if (objects.length >= MAX_OBJECTS && continuationToken) {
      throw new Error(
        `Object inventory for ${bucket} exceeds MAX_OBJECTS=${MAX_OBJECTS}. Increase MAX_OBJECTS and retry; refusing to mark a truncated migration complete.`
      )
    }
    if (!continuationToken) return objects
  }
}

function diffObjects(sourceObjects, destObjects) {
  const destinationMap = new Map(destObjects.map((object) => [object.key, object]))
  const missing = []
  const mismatched = []
  for (const sourceObject of sourceObjects) {
    const destination = destinationMap.get(sourceObject.key)
    if (!destination) {
      missing.push(sourceObject)
    } else if (
      destination.size !== sourceObject.size ||
      (sourceObject.etag && destination.etag && !sourceObject.etag.includes("-") && !destination.etag.includes("-") && sourceObject.etag !== destination.etag)
    ) {
      mismatched.push({ ...sourceObject, destinationSize: destination.size, destinationEtag: destination.etag })
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

async function hashObject(client, bucket, key, abortSignal) {
  const response = await withRetries(
    `hash ${bucket}/${key}`,
    () => client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), abortSignal ? { abortSignal } : undefined),
    S3_RETRIES
  )
  const body = response.Body
  if (!body) throw new Error(`Object body missing while hashing ${bucket}/${key}`)
  const hash = createHash("sha256")
  try {
    for await (const chunk of body) {
      if (abortSignal?.aborted) throw new JobAbortedError()
      hash.update(chunk)
    }
    return hash.digest("hex")
  } finally { closeBodyStream(body) }
}

async function inspectAssignedObjects(sourceClient, targetClient, sourceBucket, targetBucket, objects, abortSignal) {
  const found = []
  await runConcurrent(objects, Math.min(2, COPY_CONCURRENCY), async (object) => {
    let targetHead
    try {
      targetHead = await withRetries(`head target ${targetBucket}/${object.key}`, () => targetClient.send(new HeadObjectCommand({ Bucket: targetBucket, Key: object.key })), S3_RETRIES)
    } catch (error) {
      if (isObjectNotFoundError(error)) return
      throw error
    }
    const actualSize = typeof targetHead.ContentLength === "number" ? targetHead.ContentLength : -1
    if (actualSize !== Number(object.size)) { found.push({ key: object.key, size: actualSize }); return }
    const [sourceSha256, destinationSha256] = await Promise.all([
      hashObject(sourceClient, sourceBucket, object.key, abortSignal),
      hashObject(targetClient, targetBucket, object.key, abortSignal),
    ])
    found.push({
      key: object.key,
      size: sourceSha256 === destinationSha256 ? actualSize : -1,
      destinationSize: actualSize,
      destinationEtag: typeof targetHead.ETag === "string" ? targetHead.ETag.replace(/^"|"$/g, "") : null,
      sourceSha256,
      destinationSha256,
      integrityVerified: sourceSha256 === destinationSha256,
    })
  })
  return found
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

function buildObjectMetadataParams(sourceHead) {
  return {
    ...(typeof sourceHead.ContentType === "string" ? { ContentType: sourceHead.ContentType } : {}),
    ...(typeof sourceHead.CacheControl === "string" ? { CacheControl: sourceHead.CacheControl } : {}),
    ...(sourceHead.Metadata ? { Metadata: sourceHead.Metadata } : {}),
  }
}

function createProgressTransform(onChunk) {
  return new Transform({
    transform(chunk, encoding, callback) {
      if (Buffer.isBuffer(chunk) || typeof chunk.length === "number") onChunk(chunk.length)
      callback(null, chunk)
    },
  })
}

async function copyObjectWithRangedMultipart(sourceClient, targetClient, sourceBucket, targetBucket, key, sourceHead, options = {}) {
  const sourceSize = typeof sourceHead.ContentLength === "number" ? sourceHead.ContentLength : 0
  const checkpoint = async (state) => { options.multipartState = state; await options.onMultipartCheckpoint?.(state) }
  const partCount = Math.ceil(sourceSize / UPLOAD_PART_SIZE)
  const parts = Array.from({ length: partCount }, (_, index) => {
    const start = index * UPLOAD_PART_SIZE
    const end = Math.min(sourceSize - 1, start + UPLOAD_PART_SIZE - 1)
    return { partNumber: index + 1, start, end, size: end - start + 1 }
  })
  let uploadId = options.multipartState?.key === key && Number(options.multipartState?.sourceSize) === sourceSize
    ? String(options.multipartState?.uploadId || "")
    : ""
  const uploadedParts = []
  const partProgress = new Map()
  let reportedLoaded = 0

  if (uploadId) {
    try {
      let marker
      do {
        const listed = await targetClient.send(new ListPartsCommand({ Bucket: targetBucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }))
        for (const part of listed.Parts || []) {
          if (part.PartNumber && part.ETag) uploadedParts.push({ PartNumber: part.PartNumber, ETag: part.ETag, Size: Number(part.Size || 0) })
        }
        marker = listed.IsTruncated ? listed.NextPartNumberMarker : undefined
      } while (marker)
    } catch { uploadId = ""; uploadedParts.length = 0 }
  }
  if (!uploadId) {
    const createResult = await targetClient.send(new CreateMultipartUploadCommand({ Bucket: targetBucket, Key: key, ...buildObjectMetadataParams(sourceHead) }), options.abortSignal ? { abortSignal: options.abortSignal } : undefined)
    uploadId = String(createResult.UploadId || "")
    if (!uploadId) throw new Error(`Multipart upload id missing for ${key}`)
  }
  await checkpoint({ uploadId, key, sourceBucket, targetBucket, sourceSize, completedParts: uploadedParts.length })
  const completedParts = new Map(uploadedParts.map((part) => [part.PartNumber, part]))
  for (const part of parts) {
    const existing = completedParts.get(part.partNumber)
    if (existing && Number(existing.Size) === part.size) { partProgress.set(part.partNumber, part.size); reportedLoaded += part.size }
  }

  try {
    await runConcurrent(parts.filter((part) => !completedParts.has(part.partNumber) || Number(completedParts.get(part.partNumber)?.Size) !== part.size), RANGE_COPY_CONCURRENCY, async (part) => {
      const uploaded = await withRetries(
        `range copy ${sourceBucket}/${key} part ${part.partNumber}`,
        async () => {
          if (options.abortSignal?.aborted) throw new JobAbortedError()
          const sourceResponse = await sourceClient.send(
            new GetObjectCommand({
              Bucket: sourceBucket,
              Key: key,
              Range: `bytes=${part.start}-${part.end}`,
            }),
            options.abortSignal ? { abortSignal: options.abortSignal } : undefined
          )
          const body = sourceResponse.Body
          if (!body) throw new Error(`Source object body missing for ${key} part ${part.partNumber}`)

          let partLoaded = 0
          const uploadBody =
            typeof options.onProgress === "function" && typeof body.pipe === "function"
              ? body.pipe(
                  createProgressTransform((chunkLength) => {
                    partLoaded += chunkLength
                    const previous = partProgress.get(part.partNumber) || 0
                    const next = Math.min(part.size, Math.max(previous, partLoaded))
                    if (next > previous) {
                      partProgress.set(part.partNumber, next)
                      reportedLoaded += next - previous
                      options.onProgress({ loaded: reportedLoaded, total: sourceSize })
                    }
                  })
                )
              : body

          try {
            return await targetClient.send(
              new UploadPartCommand({
                Bucket: targetBucket,
                Key: key,
                UploadId: uploadId,
                PartNumber: part.partNumber,
                Body: uploadBody,
                ContentLength: part.size,
              }),
              options.abortSignal ? { abortSignal: options.abortSignal } : undefined
            )
          } finally {
            closeBodyStream(body)
          }
        },
        S3_RETRIES
      )

      if (!uploaded.ETag) throw new Error(`Multipart upload ETag missing for ${key} part ${part.partNumber}`)
      uploadedParts.push({ PartNumber: part.partNumber, ETag: uploaded.ETag })
      await checkpoint({ uploadId, key, sourceBucket, targetBucket, sourceSize, completedParts: uploadedParts.length, lastPartNumber: part.partNumber })
    })

    await targetClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: targetBucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: uploadedParts.sort((a, b) => a.PartNumber - b.PartNumber).map(({ PartNumber, ETag }) => ({ PartNumber, ETag })),
        },
      }),
      options.abortSignal ? { abortSignal: options.abortSignal } : undefined
    )

    // CompleteMultipartUpload can succeed while the committed object has a
    // provider-side size discrepancy. Verify the committed object before the
    // part is reported as copied; the final migration listing is a second
    // independent check.
    const targetHead = await withRetries(
      `verify target head ${targetBucket}/${key}`,
      () => targetClient.send(new HeadObjectCommand({ Bucket: targetBucket, Key: key })),
      S3_RETRIES
    )
    const targetSize = typeof targetHead.ContentLength === "number" ? targetHead.ContentLength : -1
    if (targetSize !== sourceSize) {
      throw new Error(`Size mismatch after multipart copy for ${key}: source=${sourceSize} target=${targetSize}`)
    }
    await checkpoint(null)
  } catch (error) {
    // Leave the provider-side multipart upload intact. The durable upload ID
    // and ListParts reconciliation let a replacement worker resume it.
    throw error
  }
}

async function copyObject(sourceClient, targetClient, sourceBucket, targetBucket, key, options = {}) {
  await withRetries(
    `copy ${sourceBucket}/${key}`,
    async () => {
      if (options.abortSignal?.aborted) throw new JobAbortedError()
      const requestOptions = options.abortSignal ? { abortSignal: options.abortSignal } : undefined
      const sourceHead = await sourceClient.send(new HeadObjectCommand({ Bucket: sourceBucket, Key: key }), requestOptions)
      const sourceSize = typeof sourceHead.ContentLength === "number" ? sourceHead.ContentLength : 0
      if (sourceSize > 0 && sourceSize >= RANGE_COPY_THRESHOLD) {
        await copyObjectWithRangedMultipart(sourceClient, targetClient, sourceBucket, targetBucket, key, sourceHead, options)
      } else {
        const sourceResponse = await sourceClient.send(new GetObjectCommand({ Bucket: sourceBucket, Key: key }), requestOptions)
      const body = sourceResponse.Body
      if (!body) throw new Error(`Source object body missing for ${key}`)

      const upload = new Upload({
        client: targetClient,
        params: {
          Bucket: targetBucket,
          Key: key,
          Body: body,
          ...buildObjectMetadataParams(sourceHead),
        },
        queueSize: UPLOAD_QUEUE_SIZE,
        partSize: UPLOAD_PART_SIZE,
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
        const abortUpload = () => void upload.abort().catch(() => undefined)
        options.abortSignal?.addEventListener("abort", abortUpload, { once: true })
        await upload.done()
        options.abortSignal?.removeEventListener("abort", abortUpload)
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
      }
      if (typeof options.onProgress === "function") options.onProgress({ loaded: sourceSize, total: sourceSize })
      const targetHead = await withRetries(
        `verify target head ${targetBucket}/${key}`,
        () => targetClient.send(new HeadObjectCommand({ Bucket: targetBucket, Key: key })),
        S3_RETRIES
      )
      const targetSize = typeof targetHead.ContentLength === "number" ? targetHead.ContentLength : -1
      if (targetSize !== sourceSize) {
        throw new Error(`Size mismatch after copy for ${key}: source=${sourceSize} target=${targetSize}`)
      }
      return { sourceSize, targetSize }
    },
    S3_RETRIES
  )
}

async function processItem(jobId, payload, item, completedResults, state) {
  const prefix = payload.migration?.pathPrefix || null
  // Match the migration setting used by the Super Slurper lane. Missing
  // objects are always safe to copy; an existing size mismatch is copied only
  // when overwrite is enabled. With overwrite disabled it remains a verified
  // mismatch and the job reports failure instead of silently replacing data.
  const overwrite = payload.migration?.options?.overwrite !== false
  const workerShard = normalizeWorkerShard(payload.workerShard)
  const isSharded = Boolean(workerShard && workerShard.count > 1)
  const shardLabel = isSharded ? ` shard ${workerShard.index + 1}/${workerShard.count}` : ""
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
    const startSync = await safeUpdateJob(jobId, {
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
    if (startSync?.canceled) throw new JobAbortedError()

    const assignedInventory = Array.isArray(payload.inventoryObjects) ? payload.inventoryObjects : null
    const allSourceObjects = assignedInventory || await listAllObjects(sourceClient, item.sourceBucket, prefix, ({ count, key, size }) => {
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
    const allDestinationObjects = assignedInventory
      ? await inspectAssignedObjects(sourceClient, targetClient, item.sourceBucket, item.targetBucket, assignedInventory, getJobAbortSignal(jobId))
      : await listAllObjects(targetClient, item.targetBucket, prefix, ({ count, key, size }) => {
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
    // Inventory batches come from the File Scanner and are already disjoint.
    // Legacy manual shard jobs retain deterministic filtering compatibility.
    const sourceObjects = filterObjectsForShard(allSourceObjects, item.sourceBucket, workerShard)
    const destinationObjects = filterObjectsForShard(allDestinationObjects, item.sourceBucket, workerShard)
    const sourceBytes = allSourceObjects.reduce((sum, object) => sum + Number(object?.size || 0), 0)
    const shardSourceBytes = sourceObjects.reduce((sum, object) => sum + Number(object?.size || 0), 0)
    const sourceObjectCount = allSourceObjects.length
    const shardObjectCount = sourceObjects.length
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
        totalObjects: shardObjectCount,
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
        summary: `Comparing ${item.sourceBucket}${shardLabel}: ${checked}/${shardObjectCount} files checked`,
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
      summary: `Scan complete for ${item.sourceBucket}${shardLabel}: ${initialMissing} missing, ${initialMismatched} mismatched`,
    })
    pushLog(state, `Scan complete for ${item.sourceBucket}`, {
      itemId: item.id,
      stage,
      initialMissing,
      initialMismatched,
      sourceCount: sourceObjectCount,
      shardSourceCount: shardObjectCount,
      destinationCount: destinationObjects.length,
    })

    if (payload.job.mode !== "verify_only") {
      stage = "repair_copy"
      currentStageStartedAt = new Date().toISOString()
      await runConcurrent(toRepair, COPY_CONCURRENCY, async (object) => {
        throwIfJobAborted(jobId)
        const isMismatch = typeof object?.destinationSize === "number"
        const objectSize = typeof object?.size === "number" ? object.size : 0
        if (isMismatch && !overwrite) {
          skipped += 1
          upsertFileEvent(state, {
            itemId: item.id,
            bucket: item.sourceBucket,
            key: object.key,
            size: objectSize,
            kind: "mismatched",
            stage,
            status: "skipped",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            bytesTransferred: 0,
            bytesTotal: objectSize,
            reason: "overwrite_disabled",
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
            summary: `Skipping mismatched ${item.sourceBucket} object because overwrite is disabled`,
          })
          return
        }
        const latestTargetSize = await getTargetObjectSize(targetClient, item.targetBucket, object.key)
        if (!isMismatch && latestTargetSize === objectSize) {
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
          return
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
            abortSignal: getJobAbortSignal(jobId),
            multipartState: payload.job?.progress?.multipart,
            onMultipartCheckpoint: (multipart) => updateJob(jobId, { progress: { multipart } }, { allowOffline: true }),
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
          if (getJobAbortSignal(jobId)?.aborted) throw new JobAbortedError()
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
          processedFiles: transferred + failed + skipped,
          totalFiles: toRepair.length,
          summary: `Repairing ${item.sourceBucket}: ${transferred} copied, ${failed} failed, ${skipped} skipped`,
        })

        syncLiveProgress()
      })
      const copyPhaseSync = await safeUpdateJob(jobId, {
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
              attempted: transferred + failed + skipped,
              remaining: Math.max(0, toRepair.length - transferred - failed - skipped),
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
      if (copyPhaseSync?.canceled) throw new JobAbortedError()
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
        summary: `Verify-only mode for ${item.sourceBucket}${shardLabel}: ${toRepair.length} files queued for verification`,
      })
    }

    stage = "repair_verify"
    currentStageStartedAt = new Date().toISOString()
    pushLog(state, `Verifying ${item.sourceBucket}`, {
      itemId: item.id,
      stage,
      sourceCount: shardObjectCount,
    })
    let finalDestinationObjects = assignedInventory
      ? await inspectAssignedObjects(sourceClient, targetClient, item.sourceBucket, item.targetBucket, sourceObjects, getJobAbortSignal(jobId))
      : filterObjectsForShard(await listAllObjects(targetClient, item.targetBucket, prefix), item.sourceBucket, workerShard)
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
        totalObjects: shardObjectCount,
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
        summary: `Verifying ${item.sourceBucket}${shardLabel}: ${checked}/${shardObjectCount} files checked`,
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

      await runConcurrent(remainingToRepair, COPY_CONCURRENCY, async (object) => {
        throwIfJobAborted(jobId)
        const isMismatch = typeof object?.destinationSize === "number"
        const objectSize = typeof object?.size === "number" ? object.size : 0
        if (isMismatch && !overwrite) {
          skipped += 1
          upsertFileEvent(state, {
            itemId: item.id,
            bucket: item.sourceBucket,
            key: object.key,
            size: objectSize,
            kind: "mismatched",
            stage,
            status: "skipped",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            bytesTransferred: 0,
            bytesTotal: objectSize,
            reason: "overwrite_disabled",
          })
          return
        }
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
          return
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
            abortSignal: getJobAbortSignal(jobId),
            multipartState: payload.job?.progress?.multipart,
            onMultipartCheckpoint: (multipart) => updateJob(jobId, { progress: { multipart } }, { allowOffline: true }),
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
          if (getJobAbortSignal(jobId)?.aborted) throw new JobAbortedError()
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
      })

      state.currentFile = null
      finalDestinationObjects = assignedInventory
        ? await inspectAssignedObjects(sourceClient, targetClient, item.sourceBucket, item.targetBucket, sourceObjects, getJobAbortSignal(jobId))
        : filterObjectsForShard(await listAllObjects(targetClient, item.targetBucket, prefix), item.sourceBucket, workerShard)
      finalDiff = diffObjectsByListing(sourceObjects, finalDestinationObjects)
      finalMissing = finalDiff.missing.length
      finalMismatched = finalDiff.mismatched.length
    }

    const completed = finalMissing === 0 && finalMismatched === 0
    const resolvedAllObjects = !isSharded && completed && finalDestinationObjects.length >= sourceObjects.length
    state.stats.verifiedObjects += shardObjectCount
    const itemStatus = isSharded || assignedInventory ? "running" : completed ? "completed" : "failed"
    const completionSummary = isSharded
      ? `Shard ${workerShard.index + 1}/${workerShard.count} verified for ${item.sourceBucket}`
      : completed
        ? `Repair verified for ${item.sourceBucket}`
        : `Repair incomplete for ${item.sourceBucket}: ${finalMissing} missing, ${finalMismatched} mismatched`
    state.currentFile = null
    upsertItemProgress(state, {
      itemId: item.id,
      stage,
      status: itemStatus,
      transferred,
      failed,
      skipped,
      processedFiles: Math.max(toRepair.length, transferred + failed + skipped),
      totalFiles: toRepair.length,
      initialMissing,
      initialMismatched,
      finalMissing,
      finalMismatched,
      summary: completionSummary,
      ...(isSharded
        ? {
            shardIndex: workerShard.index,
            shardCount: workerShard.count,
            shardObjectCount,
          }
        : {}),
    })
    pushLog(
      state,
      completed
        ? isSharded
          ? `Shard ${workerShard.index + 1}/${workerShard.count} verified for ${item.sourceBucket}`
          : `Repair verified for ${item.sourceBucket}`
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

    const itemCompleteSync = await safeUpdateJob(jobId, {
        status: "running",
        items: [
          {
            itemId: item.id,
            stage,
            status: itemStatus,
            summary: completionSummary,
            transferred,
            failed,
            skipped,
            details: {
              initialMissing,
              initialMismatched,
              sourceObjectCount,
              shardObjectCount,
              ...(isSharded
                ? {
                    shardComplete: completed,
                    shardIndex: workerShard.index,
                    shardCount: workerShard.count,
                  }
                : {}),
              sourceBytes,
              shardSourceBytes,
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
    if (itemCompleteSync?.canceled) throw new JobAbortedError()

    return {
      itemId: item.id,
      sourceBucket: item.sourceBucket,
      targetBucket: item.targetBucket,
      initialMissing,
      initialMismatched,
      sourceObjectCount,
      shardObjectCount,
      sourceBytes,
      shardSourceBytes,
      destinationObjectCountBefore: destinationObjects.length,
      destinationObjectCountAfter: finalDestinationObjects.length,
      transferred,
      failed,
      skipped,
      finalMissing,
      finalMismatched,
      completed,
      resolvedAllObjects,
      shardComplete: isSharded ? completed : undefined,
      shardIndex: isSharded ? workerShard.index : undefined,
      shardCount: isSharded ? workerShard.count : undefined,
      failureSamples,
      integrityProofs: assignedInventory ? finalDestinationObjects.map((object) => ({ key: object.key, size: object.destinationSize ?? object.size, destinationEtag: object.destinationEtag ?? null, sha256: object.sourceSha256 ?? null, verified: object.integrityVerified === true })) : undefined,
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
    const itemFailedSync = await safeUpdateJob(jobId, {
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
    if (itemFailedSync?.canceled) throw new JobAbortedError()
    throw error
  }
}

async function runJob(job, payload) {
  const state = createJobTelemetry(payload)
  const workerShard = normalizeWorkerShard(payload?.workerShard)
  if ((requiresWorkerShard(payload) || payload?.workerShard !== undefined) && !workerShard) {
    throw new Error("Migration shard job is missing a valid worker shard assignment; refusing to process the full migration")
  }
  const isSharded = Boolean(workerShard && workerShard.count > 1)
  const bucketCount = Array.isArray(payload?.items) ? payload.items.length : 0
  pushLog(
    state,
    isSharded
      ? `Worker shard ${workerShard.index + 1}/${workerShard.count} enabled across ${bucketCount} bucket(s)`
      : `Strict worker verification enabled across ${bucketCount} bucket(s)`,
    {
    stage: "start",
    mode: payload?.job?.mode || "repair_and_verify",
    verifyAllBuckets: payload?.job?.verifyAllBuckets === true,
    strictCompletion: payload?.job?.strictCompletion === true,
      ...(isSharded ? { shardIndex: workerShard.index, shardCount: workerShard.count } : {}),
    }
  )
  const results = []
  for (const item of Array.isArray(payload.items) ? payload.items : []) {
    results.push(await processItem(job.id, payload, item, results, state))
  }

  const totalMissing = results.reduce((sum, item) => sum + item.finalMissing, 0)
  const totalMismatched = results.reduce((sum, item) => sum + item.finalMismatched, 0)
  const totalTransferred = results.reduce((sum, item) => sum + item.transferred, 0)
  const totalFailed = results.reduce((sum, item) => sum + item.failed, 0)
  const totalVerifiedObjects = isSharded
    ? results.reduce((sum, item) => sum + Number(item.shardObjectCount || 0), 0)
    : results.reduce((sum, item) => sum + Number(item.sourceObjectCount || 0), 0)
  const completed = totalMissing === 0 && totalMismatched === 0 && totalFailed === 0
  const completionSummary = isSharded
    ? completed
      ? `Worker shard ${workerShard.index + 1}/${workerShard.count} completed across ${bucketCount} bucket(s); ${totalVerifiedObjects} objects verified, ${totalTransferred} repaired`
      : `Worker shard ${workerShard.index + 1}/${workerShard.count} incomplete: ${totalMissing} missing, ${totalMismatched} mismatched, ${totalFailed} copy failures`
    : completed
      ? `Worker reconciliation completed: destination matches source across ${bucketCount} bucket(s); ${totalVerifiedObjects} objects verified, ${totalTransferred} repaired`
      : `Worker reconciliation incomplete: ${totalMissing} missing, ${totalMismatched} mismatched, ${totalFailed} copy failures`
  pushLog(
    state,
    completionSummary,
    {
      stage: "completed",
      transferred: totalTransferred,
      failed: totalFailed,
      missing: totalMissing,
      mismatched: totalMismatched,
      verifiedObjects: totalVerifiedObjects,
    }
  )

  const finalSync = await finalizeJobUpdate(job.id, {
    status: completed ? "completed" : "failed",
    summary: completionSummary,
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
  if (finalSync?.canceled) return
}

let currentJobId = null
let currentMigrationId = null
let heartbeatLoopStarted = false
let heartbeatLoopStopped = false

async function startHeartbeatLoop() {
  while (!heartbeatLoopStopped) {
    try {
      await heartbeat({ currentJobId: currentJobId ?? null })
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
    if (!heartbeatLoopStopped) await sleep(HEARTBEAT_MS)
  }
}

function stopHeartbeatLoop() {
  heartbeatLoopStopped = true
}

async function main() {
  console.log(`Worker starting for agent ${AGENT_ID} at ${SERVER_URL}`)
  console.log(
    `Copy tuning: ${COPY_CONCURRENCY} object(s) in parallel, ${UPLOAD_QUEUE_SIZE} upload part(s) per object, ${Math.round(UPLOAD_PART_SIZE / 1024 / 1024)} MB parts`
  )
  if (!heartbeatLoopStarted) {
    heartbeatLoopStarted = true
    void startHeartbeatLoop()
  }

  while (true) {
    try {
      const claimed = await tryClaimJob()
      if (claimed?.poolComplete === true) {
        console.log(`Worker pool is complete (${claimed.poolReason || "terminal"}); stopping worker cleanly`)
        stopHeartbeatLoop()
        return
      }
      if (!claimed?.job || !claimed?.payload) {
        await sleep(POLL_MS)
        continue
      }

      currentJobId = claimed.job.id
      currentMigrationId = claimed.payload?.migration?.id || null
      migrationItemProgressCache.clear()
      repairJobProgressCache.clear()
      jobAbortControllers.set(claimed.job.id, new AbortController())
      console.log(`Claimed job ${claimed.job.id} for migration ${claimed.payload?.migration?.id || "-"}`)
      await runJob(claimed.job, claimed.payload)
      console.log(`Finished job ${claimed.job.id}`)
      currentJobId = null
      currentMigrationId = null
      migrationItemProgressCache.clear()
      repairJobProgressCache.clear()
      jobAbortControllers.delete(claimed.job.id)
      if (EXIT_AFTER_JOB) {
        console.log(`Exit-after-job enabled; stopping worker after job ${claimed.job.id}`)
        stopHeartbeatLoop()
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
      if (failedJobId) jobAbortControllers.delete(failedJobId)
      if (EXIT_AFTER_JOB && failedJobId) {
        console.log(`Exit-after-job enabled; stopping worker after terminal job ${failedJobId}`)
        stopHeartbeatLoop()
        return
      }
      await sleep(POLL_MS)
    }
  }
}

async function runWorkerForever() {
  while (true) {
    try {
      await loadRuntimeConfiguration()
      await ensureWorkerIdentity()
      await main()
      return
    } catch (error) {
      console.error("Worker fatal error:", error instanceof Error ? error.stack || error.message : String(error))
      currentJobId = null
      currentMigrationId = null
      migrationItemProgressCache.clear()
      repairJobProgressCache.clear()
      if (EXIT_AFTER_JOB) {
        stopHeartbeatLoop()
        return
      }
      await sleep(POLL_MS)
    }
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason instanceof Error ? reason.stack || reason.message : String(reason))
})

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error instanceof Error ? error.stack || error.message : String(error))
})

void runWorkerForever()
