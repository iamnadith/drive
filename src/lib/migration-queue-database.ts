import { createHash } from "node:crypto"
import { Client, Pool } from "pg"
import { readMigrationQueueLiveProjectionFromClient } from "./migration-queue-projection"
export { readMigrationQueueLiveProjectionFromClient } from "./migration-queue-projection"

type QueuePoolRegistry = typeof globalThis & { __driveMigrationQueuePools?: Map<string, Pool> }

function migrationQueuePool(url: string, ssl: boolean) {
  const normalized = new URL(url)
  normalized.searchParams.delete("sslmode")
  const key = createHash("sha256").update(`${normalized.toString()}\n${ssl ? "ssl" : "no-ssl"}`).digest("hex")
  const registry = globalThis as QueuePoolRegistry
  registry.__driveMigrationQueuePools ??= new Map<string, Pool>()
  let pool = registry.__driveMigrationQueuePools.get(key)
  if (!pool) {
    pool = new Pool({
      connectionString: normalized.toString(),
      ssl: ssl ? true : false,
      keepAlive: true,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 5_000,
      max: 1,
      allowExitOnIdle: true,
      application_name: "drive-migration-queue-control",
    })
    pool.on("error", (error) => console.error("Migration queue database pool error", "code" in error ? error.code : error.name || "unknown"))
    registry.__driveMigrationQueuePools.set(key, pool)
  }
  return pool
}

export async function withMigrationQueueDatabase<T>(url: string, operation: (db: Client) => Promise<T>, ssl = true): Promise<T> {
  const client = await migrationQueuePool(url, ssl).connect()
  try { return await operation(client as unknown as Client) } finally { client.release() }
}

export async function deleteMigrationQueueData(url: string, migrationId: string, ssl = true) {
  return withMigrationQueueDatabase(url, async (db) => {
    const tables = await db.query(`select to_regclass('public.drive_migration_queue_jobs') jobs,
      to_regclass('public.drive_migration_queue_workers') workers,
      to_regclass('public.drive_migration_queue_meta') meta`)
    if (!tables.rows[0]?.jobs && !tables.rows[0]?.workers && !tables.rows[0]?.meta) return { jobs: 0, workers: 0, meta: 0 }
    await db.query("begin")
    try {
      const jobs = tables.rows[0].jobs ? await db.query("delete from drive_migration_queue_jobs where migration_id=$1", [migrationId]) : { rowCount: 0 }
      const workers = tables.rows[0].workers ? await db.query("delete from drive_migration_queue_workers where migration_id=$1", [migrationId]) : { rowCount: 0 }
      const meta = tables.rows[0].meta ? await db.query("delete from drive_migration_queue_meta where migration_id=$1", [migrationId]) : { rowCount: 0 }
      await db.query("commit")
      return { jobs: jobs.rowCount || 0, workers: workers.rowCount || 0, meta: meta.rowCount || 0 }
    } catch (error) {
      await db.query("rollback").catch(() => undefined)
      throw error
    }
  }, ssl)
}

export async function ensureMigrationQueueSchema(db: Client) {
  await db.query(`
    create table if not exists drive_migration_queue_meta (
      migration_id uuid not null, generation integer not null, status text not null default 'seeding',
      seed_cursor text, seed_complete boolean not null default false, sync_cursor text,
      execution_config jsonb,
      total_jobs bigint not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      primary key(migration_id,generation)
    );
    alter table drive_migration_queue_meta add column if not exists sync_cursor text;
    alter table drive_migration_queue_meta add column if not exists execution_config jsonb;
    create table if not exists drive_migration_queue_jobs (
      id uuid primary key, migration_id uuid not null, generation integer not null, status text not null default 'pending',
      payload jsonb not null, progress jsonb not null default '{}'::jsonb, result jsonb not null default '{}'::jsonb,
      summary text, error text, claimed_by text, agent_id uuid, claim_token uuid, attempts integer not null default 0,
      lease_expires_at timestamptz, last_heartbeat_at timestamptz, completed_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    alter table drive_migration_queue_jobs add column if not exists agent_id uuid;
    create index if not exists drive_migration_queue_jobs_claim_idx on drive_migration_queue_jobs(migration_id,generation,status,created_at);
    create index if not exists drive_migration_queue_jobs_lease_idx on drive_migration_queue_jobs(status,lease_expires_at);
    create index if not exists drive_migration_queue_jobs_sync_idx on drive_migration_queue_jobs(migration_id,generation,updated_at,id);
    create table if not exists drive_migration_queue_workers (
      worker_instance_id text primary key, agent_id uuid, migration_id uuid not null, generation integer not null,
      status text not null default 'online', current_job_id uuid, last_heartbeat_at timestamptz not null default now(),
      runtime_seconds bigint not null default 0,
      metadata jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now()
    );
    alter table drive_migration_queue_workers add column if not exists runtime_seconds bigint not null default 0;
    update drive_migration_queue_workers set
      runtime_seconds=greatest(0,floor(extract(epoch from (
        coalesce(nullif(metadata->>'retiredAt','')::timestamptz,last_heartbeat_at)
        - coalesce(nullif(metadata->>'workerStartedAt','')::timestamptz,last_heartbeat_at)
      )))::bigint),
      metadata=metadata||jsonb_build_object('runtimeAccountingVersion',1)
      where not (metadata ? 'runtimeAccountingVersion');
  `)
}

export async function readMigrationQueueLiveProjection(url: string, ssl: boolean, migrationId: string, requestedGeneration = 0) {
  return withMigrationQueueDatabase(url, (db) => readMigrationQueueLiveProjectionFromClient(db, migrationId, requestedGeneration), ssl)
}


export function overlayMigrationQueueItems<T extends { id: string; progress: Record<string, unknown>; slurperStatus?: string; updatedAt?: string }>(
  items: T[],
  projection: { generation: number; items: Array<{ id: string; slurperStatus: string; progress: { live: Record<string, unknown> } }> },
): T[] {
  const liveById = new Map(projection.items.map((item) => [item.id, item]))
  return items.map((item) => {
    const current = liveById.get(item.id)
    if (!current) return item
    const updatedAt = typeof current.progress.live.updatedAt === "string" ? current.progress.live.updatedAt : item.updatedAt
    const migrationQueue = isRecord(item.progress.migrationQueue) ? item.progress.migrationQueue : {}
    const baseline = isRecord(migrationQueue.retryBaseline) ? migrationQueue.retryBaseline : {}
    const numericBaseline = (key: string) => {
      const value = Number(baseline[key] || 0)
      return Number.isFinite(value) ? Math.max(0, value) : 0
    }
    const verification = isRecord(item.progress.fileVerification) ? item.progress.fileVerification : {}
    const verifiedFailures = Math.max(0, Number(verification.missing ?? verification.missingObjects ?? 0) || 0)
      + Math.max(0, Number(verification.mismatched ?? verification.mismatchedObjects ?? 0) || 0)
    const verificationState = "verificationState" in item && isRecord(item.verificationState)
      ? item.verificationState
      : {}
    const verificationStatus = String(verificationState.status || verification.status || "").toLowerCase()
    const verificationMissing = Number(verificationState.missingObjects ?? verification.missing ?? 0)
    const verificationMismatched = Number(verificationState.mismatchedObjects ?? verification.mismatched ?? 0)
    const verificationExtra = Number(verificationState.extraObjects ?? verification.extra ?? 0)
    const verificationPassed = verificationStatus === "completed"
      && verificationMissing === 0
      && verificationMismatched === 0
      && (verificationState.strictDestination !== true || verificationExtra === 0)
    const transferTotalJobs = Number(current.progress.live.totalJobs ?? 0)
    const transferCompletedJobs = Number(current.progress.live.completedJobs ?? 0)
    const transferRemainingJobs = Number(current.progress.live.remainingJobs)
    const transferComplete = transferTotalJobs > 0
      && transferCompletedJobs >= transferTotalJobs
      && (Number.isFinite(transferRemainingJobs)
        ? transferRemainingJobs === 0
        : Number(current.progress.live.queuedJobs ?? 0) === 0 && Number(current.progress.live.runningJobs ?? 0) === 0)
      && Number(current.progress.live.failedJobs ?? 0) === 0
      && Number(current.progress.live.canceledJobs ?? 0) === 0
    const verificationFailed = verificationStatus === "failed"
      || (verificationStatus === "completed" && !verificationPassed)
    const queueLifecycleStatus = transferComplete && !verificationPassed
      ? verificationFailed ? "verification_failed" : verificationStatus === "running" ? "verifying" : "awaiting_verification"
      : current.slurperStatus
    const live = {
      ...current.progress.live,
      ...(transferComplete && !verificationPassed ? { status: queueLifecycleStatus, awaitingVerification: !verificationFailed } : {}),
      totalObjects: Math.max(Number(current.progress.live.totalObjects || 0), numericBaseline("totalObjects")),
      transferredObjects: numericBaseline("transferredObjects") + Number(current.progress.live.transferredObjects || 0),
      skippedObjects: numericBaseline("skippedObjects") + Number(current.progress.live.skippedObjects || 0),
      failedObjects: Number(current.progress.live.failedObjects || 0) + verifiedFailures,
      sourceBytes: Math.max(Number(current.progress.live.sourceBytes || 0), numericBaseline("sourceBytes")),
    }
    return { ...item, slurperStatus: queueLifecycleStatus, progress: { ...item.progress, migrationQueue: { ...migrationQueue, generation: projection.generation }, live }, updatedAt }
  })
}

export function resolveMigrationQueueLifecycleStatus<T extends string>(status: T, projection: { seedComplete: boolean; stats: { failedJobs: number; remainingJobs: number } }): T | "failed" {
  if (projection.seedComplete && projection.stats.failedJobs > 0 && projection.stats.remainingJobs === 0) return "failed"
  return status
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
