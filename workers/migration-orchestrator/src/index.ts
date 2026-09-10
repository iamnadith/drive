import { Client } from "pg"

type DispatchMessage = { intentId: string } | { control: "cycle" }
type Env = { POSTGRES_URL?: string; MIGRATION_ORCHESTRATOR_SECRET?: string; PANEL_URL?: string; DISABLE_POSTGRES_SSL?: string; GITHUB_DISPATCH_QUEUE: Queue<DispatchMessage> }
type Row = Record<string, any>
const BUILD = 10
const MAX_SECRET_LENGTH = 512
let authCache: { value: string[]; expiresAt: number } | null = null

function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store, max-age=0" } }) }
function safeEqual(a: string, b: string) {
  if (a.length > MAX_SECRET_LENGTH || b.length > MAX_SECRET_LENGTH) return false
  let different = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) different |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return different === 0
}
async function authorized(request: Request, env: Env) {
  const value = request.headers.get("authorization") || ""
  if (!value.toLowerCase().startsWith("bearer ")) return false
  const supplied = value.slice(7).trim()
  if (authCache && authCache.expiresAt > Date.now()) return authCache.value.some((value) => safeEqual(supplied, value))
  return database(env, async (db) => {
    const expected = String(env.MIGRATION_ORCHESTRATOR_SECRET || "")
    const stored = String((await db.query(`select value->>'sharedSecret' secret from drive_app_settings where key='migration-orchestrator' limit 1`)).rows[0]?.secret || "")
    if (!safeEqual(expected, stored)) return false
    if (expected.length >= 24 && expected.length <= MAX_SECRET_LENGTH) authCache = { value: [expected], expiresAt: Date.now() + 30_000 }
    return expected.length >= 24 && expected.length <= MAX_SECRET_LENGTH && safeEqual(supplied, expected)
  }).catch(() => false)
}
async function database<T>(env: Env, operation: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = String(env.POSTGRES_URL || "").trim()
  if (!connectionString) throw new Error("POSTGRES_URL is not configured")
  const hostname = new URL(connectionString).hostname
  const disableSsl = ["1", "true"].includes(String(env.DISABLE_POSTGRES_SSL || "").toLowerCase())
  const client = new Client({ connectionString, ssl: disableSsl || ["localhost", "127.0.0.1"].includes(hostname) ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 8_000 })
  await client.connect()
  try { return await operation(client) } finally { await client.end().catch(() => undefined) }
}
async function ensureSchema(db: Client) {
  await db.query(`
    create table if not exists drive_migration_orchestrator_state (
      id boolean primary key default true check (id), status text not null default 'idle', orchestrator_url text,
      lease_owner text, lease_expires_at timestamptz, last_started_at timestamptz, last_completed_at timestamptz, last_error text,
      last_migration_id uuid references drive_migrations(id) on delete set null,
      last_result jsonb not null default '{}'::jsonb, cycle_count bigint not null default 0, updated_at timestamptz not null default now()
    );
    alter table if exists drive_migration_orchestrator_state add column if not exists lease_owner text;
    alter table if exists drive_migration_orchestrator_state add column if not exists lease_expires_at timestamptz;
    create table if not exists drive_migration_verification_state (
      migration_item_id uuid primary key references drive_migration_items(id) on delete cascade,
      migration_id uuid not null references drive_migrations(id) on delete cascade, generation integer not null default 1,
      source_scan_id uuid references drive_bucket_scans(id) on delete set null, destination_scan_id uuid references drive_bucket_scans(id) on delete set null,
      phase text not null default 'source', status text not null default 'pending', source_cursor text, destination_cursor text,
      source_objects bigint not null default 0, source_bytes bigint not null default 0, destination_objects bigint not null default 0, destination_bytes bigint not null default 0,
      missing_objects bigint not null default 0, mismatched_objects bigint not null default 0, extra_objects bigint not null default 0,
      attempt_count integer not null default 0, last_error text, lease_owner text, lease_expires_at timestamptz,
      completed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
  `)
}
function opts(row: Row): Row { return row.options && typeof row.options === "object" ? row.options : {} }
function integer(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback
}
async function acquire(db: Client, owner: string) {
  const result = await db.query(`
    insert into drive_migration_orchestrator_state(id,status,lease_owner,lease_expires_at,last_started_at,last_error,updated_at)
    values(true,'running',$1,now()+interval '150 seconds',now(),null,now())
    on conflict(id) do update set status='running',lease_owner=$1,lease_expires_at=now()+interval '150 seconds',last_started_at=now(),last_error=null,updated_at=now()
      where drive_migration_orchestrator_state.status<>'running' or drive_migration_orchestrator_state.lease_expires_at is null or drive_migration_orchestrator_state.lease_expires_at<now()
    returning id
  `, [owner])
  return result.rowCount === 1
}
async function renew(db: Client, owner: string) {
  const result = await db.query(`update drive_migration_orchestrator_state set lease_expires_at=now()+interval '150 seconds',updated_at=now() where id=true and status='running' and lease_owner=$1 returning id`, [owner])
  if (result.rowCount !== 1) throw new Error("Migration Orchestrator lease was lost")
}
async function selectMigration(db: Client): Promise<Row | null> {
  const result = await db.query(`select * from drive_migrations where status in ('running','verifying') and options->>'executionMode'='migration_workers' order by coalesce(last_synced_at,created_at),created_at limit 1`)
  return result.rows[0] || null
}
async function ensureShards(db: Client, migration: Row) {
  const generation = integer(opts(migration).workerGeneration, 1, 1, 1000000)
  const items = await db.query(`select id,source_bucket,target_bucket,progress from drive_migration_items where migration_id=$1 and coalesce(slurper_status,'')<>'worker_bucket_create_failed' order by created_at`, [migration.id])
  if (!items.rowCount) {
    await db.query(`update drive_migrations set status='failed',sync_status='failed',sync_message='No migration buckets are available for worker processing',last_synced_at=now(),updated_at=now() where id=$1`, [migration.id])
    return { generation, shardCount: 0, created: 0, inventoryPending: 0, terminalFailure: true }
  }
  let inventoryPending = 0
  for (const item of items.rows) {
    const inventory = item.progress?.migrationInventory || {}
    const inventoryGeneration = Number(inventory.generation)
    const adoptLegacyGenerationOne = generation === 1 && inventory.generation == null
    let scanId = inventoryGeneration === generation || adoptLegacyGenerationOne ? String(inventory.sourceScanId || "") : ""
    if (!scanId) {
      // Adopt a panel-seeded active inventory before creating one. This makes
      // the panel and cron/wake paths converge on one scan even if they run at
      // nearly the same time. Completed scans are not reused across repair
      // generations.
      const existing = await db.query(`select id from drive_bucket_scans where account_id=$1 and bucket_name=$2 and migration_id=$3 and migration_item_id=$4 and kind='source' and status in('pending','running') order by updated_at desc limit 1`, [migration.source_account_id, item.source_bucket, migration.id, item.id])
      if (existing.rows[0]?.id) scanId = existing.rows[0].id
      else {
        const scan = await db.query(`insert into drive_bucket_scans(id,account_id,bucket_name,kind,migration_id,migration_item_id,status,updated_at) values(gen_random_uuid(),$1,$2,'source',$3,$4,'pending',now()) returning id`, [migration.source_account_id, item.source_bucket, migration.id, item.id])
        scanId = scan.rows[0].id
      }
      await db.query(`update drive_migration_items set progress=jsonb_set(coalesce(progress,'{}'::jsonb),'{migrationInventory}',$2::jsonb),slurper_status='scanning',updated_at=now() where id=$1`, [item.id, JSON.stringify({ sourceScanId: scanId, generation, status: "scanning" })])
    }
    const scan = (await db.query(`select status,error from drive_bucket_scans where id=$1`, [scanId])).rows[0]
    if (scan?.status === "failed") throw new Error(scan.error || `Source inventory failed for ${item.source_bucket}`)
    if (scan?.status !== "completed") inventoryPending += 1
  }
  if (inventoryPending) return { generation, shardCount: 0, created: 0, inventoryPending }
  await db.query(`
    update drive_migration_items i set source_objects=s.objects,source_bytes=s.bytes,last_progress_at=now(),updated_at=now(),
      progress=jsonb_set(coalesce(i.progress,'{}'::jsonb),'{migrationInventory}',coalesce(i.progress->'migrationInventory','{}'::jsonb)||jsonb_build_object('status','completed','completedAt',s.completed_at))
    from drive_bucket_scans s where i.migration_id=$1 and s.id=(i.progress->'migrationInventory'->>'sourceScanId')::uuid and s.status='completed'
  `, [migration.id])
  const queueItem = items.rows.find((item) => Number(item.progress?.migrationQueue?.generation) !== generation || item.progress?.migrationQueue?.status !== "completed")
  let created = 0
  if (queueItem) {
    const scanId = String(queueItem.progress?.migrationInventory?.sourceScanId || "")
    const lastKey = Number(queueItem.progress?.migrationQueue?.generation) === generation ? String(queueItem.progress?.migrationQueue?.lastKey || "") : ""
    const page = await db.query(`select key,size,etag from drive_bucket_scan_objects where scan_id=$1 and not is_dir_marker and key>$2 order by key limit 100`, [scanId, lastKey])
    await db.query("begin")
    try {
      for (const object of page.rows) {
        const inserted = await db.query(`
          insert into drive_repair_jobs(id,migration_id,status,mode,work_key,payload,progress,result,created_at,updated_at)
          values(gen_random_uuid(),$1::uuid,'pending','migration',format('migration:%s:generation:%s:inventory:%s:%s',$1::uuid,$2::int,$3::uuid,encode(convert_to($4::text,'UTF8'),'hex')),
            jsonb_build_object('source','file_scanner_inventory','kind','migration_inventory_file','workerGeneration',$2::int,'itemIds',jsonb_build_array($3::uuid),'inventoryObjects',jsonb_build_array(jsonb_build_object('key',$4::text,'size',$5::bigint,'etag',$6::text))),
            '{}'::jsonb,'{}'::jsonb,now(),now()) on conflict(work_key) where work_key is not null do nothing
        `, [migration.id, generation, queueItem.id, object.key, object.size, object.etag])
        created += inserted.rowCount || 0
      }
      const completed = page.rowCount === 0
      const nextKey = page.rows[page.rows.length - 1]?.key || lastKey
      await db.query(`update drive_migration_items set progress=jsonb_set(coalesce(progress,'{}'::jsonb),'{migrationQueue}',$2::jsonb),updated_at=now() where id=$1`, [queueItem.id, JSON.stringify({ generation, status: completed ? "completed" : "materializing", lastKey: nextKey, updatedAt: new Date().toISOString() })])
      await db.query("commit")
    } catch (error) { await db.query("rollback").catch(() => undefined); throw error }
    return { generation, shardCount: 0, created, inventoryPending: 0, queuePending: 1 }
  }
  // Normalize pending jobs created by an older orchestrator build. Migration
  // mode has the same copy-and-verify guarantees, but keeps full migrations
  // distinct from ad-hoc repair jobs throughout the API and UI.
  await db.query(`update drive_repair_jobs set mode='migration',updated_at=now() where migration_id=$1 and status='pending' and work_key like $2 and mode<>'migration'`, [migration.id, `migration:${migration.id}:generation:${generation}:inventory:%`])
  const total = await db.query(`select count(*)::int count from drive_repair_jobs where migration_id=$1 and work_key like $2`, [migration.id, `migration:${migration.id}:generation:${generation}:inventory:%`])
  const shardCount = Number(total.rows[0]?.count || 0)
  if (!shardCount) {
    await db.query(`update drive_migration_items set slurper_status='completed',source_objects=0,source_bytes=00,updated_at=now() where migration_id=$1`, [migration.id])
  }
  return { generation, shardCount, created, inventoryPending: 0, queuePending: 0 }
}
async function recoverJobs(db: Client, migrationId: string, generation: number, shardCount: number) {
  const result = await db.query(`
    update drive_repair_jobs set status='pending',claimed_by_agent_id=null,claim_token=null,claimed_at=null,started_at=null,last_heartbeat_at=null,error=null,
      summary='Recovered by Migration Orchestrator',result=jsonb_set(coalesce(result,'{}'::jsonb),'{retryCount}',to_jsonb(coalesce((result->>'retryCount')::int,0)+1)),updated_at=now()
    where migration_id=$1 and work_key like $2 and work_key like $3 and ((status='failed' and coalesce((result->>'retryCount')::int,0)<3) or status='canceled' or (status in('claimed','running') and coalesce(last_heartbeat_at,started_at,claimed_at,updated_at)<now()-interval '3 minutes'))
  `, [migrationId, `migration:${migrationId}:generation:${generation}:inventory:%`, `%`])
  return result.rowCount || 0
}
async function finalizeShards(db: Client, migration: Row, generation: number, shardCount: number) {
  const counts = await db.query(`select status,count(*)::int count from drive_repair_jobs where migration_id=$1 and work_key like $2 group by status`, [migration.id, `migration:${migration.id}:generation:${generation}:inventory:%`])
  const jobs = Object.fromEntries(counts.rows.map((row) => [row.status, Number(row.count)]))
  if ((jobs.completed || 0) !== shardCount) {
    const terminal = (jobs.completed || 0) + (jobs.failed || 0) + (jobs.canceled || 0)
    if (terminal === shardCount && ((jobs.failed || 0) > 0 || (jobs.canceled || 0) > 0)) {
      await db.query(`update drive_migrations set status='failed',sync_status='failed',sync_message='Migration worker retries exhausted',last_synced_at=now(),updated_at=now() where id=$1 and status in('running','verifying')`, [migration.id])
      return { complete: false, terminalFailure: true, jobs }
    }
    return { complete: false, jobs }
  }
  await db.query(`update drive_migration_items set slurper_status='completed',last_progress_at=now(),updated_at=now(),progress=jsonb_set(jsonb_set(coalesce(progress,'{}'::jsonb),'{repairWorkerStatus}','"completed"'::jsonb),'{stage}','"awaiting_independent_verification"'::jsonb) where migration_id=$1 and coalesce(slurper_status,'')<>'worker_bucket_create_failed'`, [migration.id])
  await db.query(`update drive_migrations set status='verifying',sync_status='running',sync_message='File Scanner verification pending',last_synced_at=now(),updated_at=now() where id=$1`, [migration.id])
  await db.query(`
    insert into drive_migration_verification_state(migration_item_id,migration_id,generation,status,phase)
    select id,migration_id,$2,'pending','source' from drive_migration_items where migration_id=$1
    on conflict(migration_item_id) do update set generation=excluded.generation,
      status=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.status else 'pending' end,
      phase=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.phase else 'source' end,
      source_scan_id=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.source_scan_id else null end,
      destination_scan_id=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.destination_scan_id else null end,
      source_cursor=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.source_cursor else null end,
      destination_cursor=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.destination_cursor else null end,
      source_objects=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.source_objects else 0 end,
      source_bytes=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.source_bytes else 0 end,
      destination_objects=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.destination_objects else 0 end,
      destination_bytes=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.destination_bytes else 0 end,
      missing_objects=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.missing_objects else 0 end,
      mismatched_objects=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.mismatched_objects else 0 end,
      extra_objects=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.extra_objects else 0 end,
      attempt_count=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.attempt_count else 0 end,
      last_error=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.last_error else null end,
      lease_owner=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.lease_owner else null end,
      lease_expires_at=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.lease_expires_at else null end,
      completed_at=case when drive_migration_verification_state.generation=excluded.generation then drive_migration_verification_state.completed_at else null end,
      updated_at=now()
  `, [migration.id, generation])
  return { complete: true, jobs }
}
async function cloudflare(account: Row, path: string, method = "GET", body?: unknown, allow404 = false) {
  if (!account.cloudflare_account_id || !account.api_token) throw new Error("Cloudflare account ID or API token is missing")
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.cloudflare_account_id)}${path}`, {
    method, headers: { Authorization: `Bearer ${account.api_token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  })
  if (allow404 && response.status === 404) return null
  const payload = await response.json().catch(() => ({})) as Row
  if (!response.ok || payload.success === false) throw new Error(payload.errors?.[0]?.message || `Cloudflare API returned HTTP ${response.status}`)
  return payload.result ?? payload
}
async function syncNextBucketSettings(db: Client, migration: Row) {
  const pending = await db.query(`select * from drive_migration_items where migration_id=$1 and coalesce(progress->'orchestratorSettings'->>'status','')<>'synced' order by created_at limit 1`, [migration.id])
  const item = pending.rows[0]
  if (!item) return { settings: "synced" }
  const accounts = await db.query(`select id,cloudflare_account_id,api_token from drive_accounts where id in($1,$2)`, [migration.source_account_id, migration.target_account_id])
  const source = accounts.rows.find((row) => row.id === migration.source_account_id); const target = accounts.rows.find((row) => row.id === migration.target_account_id)
  if (!source || !target) throw new Error("Source or target account is missing")
  const attempts = integer(item.progress?.orchestratorSettings?.attempts, 0, 0, 100)
  const sourcePath = `/r2/buckets/${encodeURIComponent(item.source_bucket)}`; const targetPath = `/r2/buckets/${encodeURIComponent(item.target_bucket)}`
  try {
    const [cors, domain] = await Promise.all([
      cloudflare(source, `${sourcePath}/cors`, "GET", undefined, true),
      cloudflare(source, `${sourcePath}/domains/managed`, "GET", undefined, true),
    ])
    const rules = Array.isArray(cors?.rules) ? cors.rules : []
    await cloudflare(target, `${targetPath}/cors`, rules.length ? "PUT" : "DELETE", rules.length ? { rules } : undefined, true)
    await cloudflare(target, `${targetPath}/domains/managed`, "PUT", { enabled: domain?.enabled === true })
    await db.query(`update drive_migration_items set progress=jsonb_set(coalesce(progress,'{}'::jsonb),'{orchestratorSettings}',$2::jsonb),updated_at=now() where id=$1`, [item.id, JSON.stringify({ status: "synced", attempts: attempts + 1, syncedAt: new Date().toISOString() })])
    return { settings: "progress", itemId: item.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.query(`update drive_migration_items set progress=jsonb_set(coalesce(progress,'{}'::jsonb),'{orchestratorSettings}',$2::jsonb),updated_at=now() where id=$1`, [item.id, JSON.stringify({ status: attempts >= 2 ? "failed" : "pending", attempts: attempts + 1, error: message, updatedAt: new Date().toISOString() })])
    if (attempts >= 2) await db.query(`update drive_migrations set status='failed',sync_status='failed',sync_message=$2,updated_at=now() where id=$1`, [migration.id, `Bucket settings sync failed for ${item.source_bucket}: ${message}`])
    return { settings: attempts >= 2 ? "failed" : "retry", itemId: item.id, error: message }
  }
}
async function wakeBackendOrchestrator(db: Client) {
  const result = await db.query(`select value from drive_app_settings where key='backend-orchestrator' limit 1`)
  const settings = result.rows[0]?.value || {}
  if (!settings.enabled || !settings.orchestratorUrl || !settings.sharedSecret) return "not_configured"
  try {
    const response = await fetch(`${String(settings.orchestratorUrl).replace(/\/+$/, "")}/run`, { method: "POST", headers: { Authorization: `Bearer ${settings.sharedSecret}` }, signal: AbortSignal.timeout(8_000) })
    return response.ok ? "signaled" : `http_${response.status}`
  } catch { return "deferred_to_cron" }
}
async function finishOrRepair(db: Client, migration: Row, generation: number) {
  const states = await db.query(`select status,missing_objects,mismatched_objects,extra_objects from drive_migration_verification_state where migration_id=$1 and generation=$2`, [migration.id, generation])
  if (states.rows.some((row) => row.status === "failed")) {
    await db.query(`update drive_migrations set status='failed',sync_status='failed',sync_message='File Scanner exhausted its scan retries',updated_at=now() where id=$1`, [migration.id])
    return { verification: "failed", reason: "file_scan_failed" }
  }
  if (!states.rows.length || states.rows.some((row) => row.status !== "completed")) return { verification: "pending" }
  const missing = states.rows.reduce((n, row) => n + Number(row.missing_objects), 0)
  const mismatched = states.rows.reduce((n, row) => n + Number(row.mismatched_objects), 0)
  const extra = states.rows.reduce((n, row) => n + Number(row.extra_objects), 0)
  if (missing || mismatched || (opts(migration).verifyStrictDestination === true && extra)) {
    await db.query(`update drive_migrations set status='failed',sync_status='failed',sync_message=$2,last_synced_at=now(),updated_at=now() where id=$1`, [migration.id, `File Scanner verification found ${missing} missing, ${mismatched} mismatched, ${extra} extra; repair is available`])
    return { verification: "failed", missing, mismatched, extra, repairAvailable: true }
  }
  const settings = await syncNextBucketSettings(db, migration)
  if (settings.settings !== "synced") return { verification: settings.settings === "failed" ? "failed" : "settings_sync", missing, mismatched, extra, ...settings }
  await db.query("begin")
  try {
    await db.query(`
      with previous as (
        select total_buckets,total_objects,total_bytes,last_synced_at
        from drive_accounts where status='active' and id<>$1
        order by last_synced_at desc nulls last limit 1
      )
      update drive_accounts a set
        status=case when a.id=$1 then 'active' when a.status='active' then 'available' else a.status end,
        last_migrated=case when a.id=$1 then to_char(now(),'YYYY-MM-DD HH24:MI:SS') else a.last_migrated end,
        total_buckets=case when a.id=$1 and a.last_synced_at is null then coalesce((select total_buckets from previous),a.total_buckets) else a.total_buckets end,
        total_objects=case when a.id=$1 and a.last_synced_at is null then coalesce((select total_objects from previous),a.total_objects) else a.total_objects end,
        total_bytes=case when a.id=$1 and a.last_synced_at is null then coalesce((select total_bytes from previous),a.total_bytes) else a.total_bytes end,
        last_synced_at=case when a.id=$1 and a.last_synced_at is null then (select last_synced_at from previous) else a.last_synced_at end,
        sync_status=case when a.id=$1 then 'syncing' else a.sync_status end,
        sync_message=case when a.id=$1 then 'Awaiting Backend Orchestrator refresh; showing last committed totals' else a.sync_message end,
        updated_at=now()
      where a.id=$1 or a.status='active'
    `, [migration.target_account_id])
    await db.query(`update drive_migrations set status='completed',completed_at=now(),sync_status='synced',sync_message='Migration independently verified',last_synced_at=now(),updated_at=now(),summary_item_count=(select count(*) from drive_migration_items where migration_id=$1),summary_objects=(select coalesce(sum(source_objects),0) from drive_migration_items where migration_id=$1),summary_bytes=(select coalesce(sum(source_bytes),0) from drive_migration_items where migration_id=$1) where id=$1`, [migration.id])
    await db.query("commit")
  } catch (error) { await db.query("rollback"); throw error }
  return { verification: "completed", missing, mismatched, extra, backendOrchestrator: await wakeBackendOrchestrator(db) }
}
async function dispatchWorkers(db: Client, env: Env, migration: Row) {
  const ids = Array.isArray(opts(migration).workerAgentIds) ? opts(migration).workerAgentIds.filter((id: unknown) => typeof id === "string") : []
  const configRows = await db.query(`select key,value from drive_app_settings where key='migration-orchestrator'`)
  const orchestration = configRows.rows.find((row) => row.key === "migration-orchestrator")?.value || {}
  if (!ids.length) return 0
  const budget = integer(orchestration.maxDispatchesPerCycle, 100, 1, 100)
  const stranded = await db.query(`select id from drive_agent_runs where run_type='github_dispatch' and status='pending' and payload->>'migrationId'=$1 and coalesce(payload->>'phase','created') in('created','queued') order by created_at limit $2`, [migration.id, budget])
  for (const row of stranded.rows) await env.GITHUB_DISPATCH_QUEUE.send({ intentId: row.id }, { contentType: "json" })
  const agents = await db.query(`select id,github_repo_owner,github_repo_name,github_workflow_file,github_ref,github_token,least(5,greatest(1,coalesce(worker_count,1))) worker_count from drive_agents where id=any($1::uuid[]) and provider='github_actions' and status<>'disabled' and github_token is not null order by array_position($1::uuid[],id)`, [ids])
  let queued = stranded.rowCount || 0
  for (const agent of agents.rows) {
    await db.query(`update drive_agent_runs r set status='failed',summary='Recovered stale GitHub dispatch',completed_at=now(),updated_at=now() from drive_agents a where r.agent_id=$1 and a.id=r.agent_id and r.status in('pending','running') and r.payload->>'migrationId'=$2 and r.updated_at<now()-interval '30 minutes' and coalesce(a.last_heartbeat_at,'epoch'::timestamptz)<now()-interval '2 minutes'`, [agent.id, migration.id])
    const active = await db.query(`
      select count(*)::int count from drive_agent_runs r join drive_agents a on a.id=r.agent_id
      where r.agent_id=$1 and r.status in('pending','running')
        and (r.updated_at>now()-interval '30 minutes' or a.last_heartbeat_at>now()-interval '2 minutes')
    `, [agent.id])
    const vacancies = Math.max(0, Number(agent.worker_count || 1) - Number(active.rows[0]?.count || 0))
    for (let slot = 0; slot < vacancies && queued < budget; slot += 1) {
      const workerInstanceId = crypto.randomUUID()
      const intent = await db.query(`insert into drive_agent_runs(id,agent_id,run_type,status,payload,summary,created_at,updated_at) values(gen_random_uuid(),$1,'github_dispatch','pending',$2::jsonb,'Durable GitHub dispatch intent queued',now(),now()) returning id`, [agent.id, JSON.stringify({ migrationId: migration.id, pool: true, workerInstanceId, source: "migration_orchestrator", phase: "created" })])
      await env.GITHUB_DISPATCH_QUEUE.send({ intentId: intent.rows[0].id }, { contentType: "json" })
      await db.query(`update drive_agent_runs set payload=payload||'{"phase":"queued"}'::jsonb,summary='Queued for independent GitHub dispatch consumer',updated_at=now() where id=$1`, [intent.rows[0].id])
      queued += 1
    }
  }
  return queued
}

async function reconcileGitHubIntent(db: Client, intent: Row, agent: Row) {
  const instanceId = String(intent.payload?.workerInstanceId || "")
  if (!instanceId) throw new Error("Dispatch intent is missing workerInstanceId")
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(agent.github_repo_owner)}/${encodeURIComponent(agent.github_repo_name)}/actions/workflows/${encodeURIComponent(agent.github_workflow_file || ".github/workflows/migration-worker.yml")}/runs?event=repository_dispatch&branch=${encodeURIComponent(agent.github_ref || "main")}&per_page=50`, {
    headers: { Authorization: `Bearer ${agent.github_token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Drive-Migration-Orchestrator" }, signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub reconciliation HTTP ${response.status}`)
  const payload = await response.json() as { workflow_runs?: Array<{ id?: number; display_title?: string; html_url?: string; status?: string }> }
  const match = payload.workflow_runs?.find((run) => String(run.display_title || "").includes(instanceId))
  if (!match?.id) return false
  await db.query(`update drive_agent_runs set external_run_id=$2,status=case when $3='completed' then 'completed' else 'running' end,payload=payload||$4::jsonb,summary='GitHub workflow reconciled by instance id',updated_at=now() where id=$1`, [intent.id, String(match.id), match.status || null, JSON.stringify({ phase: "reconciled", htmlUrl: match.html_url || null })])
  return true
}

async function consumeDispatch(env: Env, intentId: string, attempts: number) {
  return database(env, async (db) => {
    const lock = await db.query(`select pg_try_advisory_lock(hashtext($1)) acquired`, [intentId])
    if (lock.rows[0]?.acquired !== true) return "awaiting_reconciliation"
    const result = await db.query(`select r.*,a.github_repo_owner,a.github_repo_name,a.github_workflow_file,a.github_ref,a.github_token,a.status agent_status from drive_agent_runs r join drive_agents a on a.id=r.agent_id where r.id=$1 for update of r`, [intentId])
    const intent = result.rows[0]
    if (!intent || intent.external_run_id || ["completed", "failed", "canceled"].includes(intent.status)) return "terminal"
    if (intent.agent_status === "disabled" || !intent.github_token) throw new Error("Registered workflow is disabled or missing its GitHub token")
    if (await reconcileGitHubIntent(db, intent, intent)) return "reconciled"
    const phase = String(intent.payload?.phase || "created")
    const dispatchStartedAt = Date.parse(String(intent.payload?.dispatchStartedAt || ""))
    if (phase === "accepted" || (phase === "dispatching" && Number.isFinite(dispatchStartedAt) && Date.now() - dispatchStartedAt < 5 * 60_000)) return "awaiting_reconciliation"
    const workerInstanceId = String(intent.payload.workerInstanceId)
    await db.query(`update drive_agent_runs set payload=payload||$2::jsonb,summary='Submitting GitHub workflow dispatch',updated_at=now() where id=$1`, [intent.id, JSON.stringify({ phase: "dispatching", dispatchStartedAt: new Date().toISOString(), dispatchAttempt: attempts })])
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(intent.github_repo_owner)}/${encodeURIComponent(intent.github_repo_name)}/dispatches`, {
      method: "POST", headers: { Authorization: `Bearer ${intent.github_token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Drive-Migration-Orchestrator", "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "drive-migration-worker", client_payload: { migration_id: intent.payload.migrationId, agent_id: intent.agent_id, worker_instance_id: workerInstanceId, workflow_file: intent.github_workflow_file || ".github/workflows/migration-worker.yml" } }), signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`GitHub dispatch HTTP ${response.status}`)
    await db.query(`update drive_agent_runs set payload=payload||$2::jsonb,summary='GitHub accepted workflow dispatch; awaiting run reconciliation',updated_at=now() where id=$1`, [intent.id, JSON.stringify({ phase: "accepted", acceptedAt: new Date().toISOString() })])
    return "accepted"
  })
}
async function wakeFileScanner(db: Client) {
  const result = await db.query(`select value from drive_app_settings where key='migration-orchestrator' limit 1`)
  const settings = result.rows[0]?.value || {}
  if (!settings.fileScannerUrl || !settings.fileScannerSecret) return "not_configured"
  try {
    const response = await fetch(`${String(settings.fileScannerUrl).replace(/\/+$/, "")}/run`, { method: "POST", headers: { Authorization: `Bearer ${settings.fileScannerSecret}` }, signal: AbortSignal.timeout(8_000) })
    return response.ok ? "signaled" : `http_${response.status}`
  } catch { return "deferred_to_cron" }
}
async function complete(db: Client, owner: string, migrationId: string | null, result: Row) {
  await db.query(`update drive_migration_orchestrator_state set status='idle',lease_owner=null,lease_expires_at=null,last_completed_at=now(),last_error=null,last_migration_id=$1,last_result=$2::jsonb,cycle_count=cycle_count+1,updated_at=now() where id=true and lease_owner=$3`, [migrationId, JSON.stringify(result), owner])
  return result
}

async function workerAuthorized(db: Client, agentId: string, token: unknown): Promise<Row | null> {
  if (typeof token !== "string" || token.length < 24 || token.length > MAX_SECRET_LENGTH) return null
  const result = await db.query(`select id,name,status,capabilities from drive_agents where id=$1 limit 1`, [agentId])
  const agent = result.rows[0]
  if (!agent || agent.status === "disabled") return null
  const settings = await db.query(`select value->>'sharedSecret' secret from drive_app_settings where key='migration-workers' limit 1`)
  const expected = String(settings.rows[0]?.secret || "")
  return expected.length >= 24 && expected.length <= MAX_SECRET_LENGTH && safeEqual(token, expected) ? agent : null
}

async function workerPayload(db: Client, job: Row) {
  const migrationResult = await db.query(`select * from drive_migrations where id=$1 limit 1`, [job.migration_id])
  const migration = migrationResult.rows[0]
  if (!migration) throw new Error("Migration not found")
  const accounts = await db.query(`select id,cloudflare_account_id,r2_access_key_id,r2_secret_access_key from drive_accounts where id in($1,$2)`, [migration.source_account_id, migration.target_account_id])
  const source = accounts.rows.find((row) => row.id === migration.source_account_id)
  const target = accounts.rows.find((row) => row.id === migration.target_account_id)
  if (!source?.cloudflare_account_id || !target?.cloudflare_account_id) throw new Error("Migration accounts are incomplete")
  const items = await db.query(`select * from drive_migration_items where migration_id=$1 order by created_at`, [migration.id])
  const requested = new Set(Array.isArray(job.payload?.itemIds) ? job.payload.itemIds : [])
  const selected = requested.size ? items.rows.filter((item) => requested.has(item.id)) : items.rows
  return {
    job: { id: job.id, mode: job.mode, migrationId: migration.id, verifyAllBuckets: true, strictCompletion: true, kind: job.payload?.kind, progress: job.progress || {} },
    ...(job.payload?.workerShard ? { workerShard: job.payload.workerShard } : {}),
    ...(typeof job.payload?.workerGeneration === "number" ? { workerGeneration: job.payload.workerGeneration } : {}),
    ...(Array.isArray(job.payload?.inventoryObjects) ? { inventoryObjects: job.payload.inventoryObjects } : {}),
    migration: { id: migration.id, options: migration.options || {}, pathPrefix: migration.options?.pathPrefix || null },
    source: { accountId: source.cloudflare_account_id, accessKeyId: source.r2_access_key_id, secretAccessKey: source.r2_secret_access_key },
    target: { accountId: target.cloudflare_account_id, accessKeyId: target.r2_access_key_id, secretAccessKey: target.r2_secret_access_key },
    items: selected.map((item) => ({ id: item.id, sourceBucket: item.source_bucket, targetBucket: item.target_bucket, sourceObjects: Number(item.source_objects || 0), sourceBytes: Number(item.source_bytes || 0), slurperStatus: item.slurper_status, progress: item.progress || {} })),
  }
}

async function workerRequest(request: Request, env: Env, path: string) {
  const body = await request.json().catch(() => ({})) as Row
  if (path === "/workers/register") {
    return database(env, async (db) => {
      const token = String(body.token || "").trim()
      const instanceId = String(body.instanceId || "").trim()
      if (!/^[0-9a-f-]{36}$/i.test(instanceId)) return json({ error: "Valid worker instanceId is required" }, 400)
      const settings = await db.query(`select value->>'sharedSecret' secret from drive_app_settings where key='migration-workers' limit 1`)
      const expected = String(settings.rows[0]?.secret || "")
      if (expected.length < 24 || expected.length > MAX_SECRET_LENGTH || !safeEqual(token, expected)) {
        return json({ error: "Invalid worker secret" }, 401)
      }
      const requestedAgentId = /^[0-9a-f-]{36}$/i.test(String(body.agentId || "")) ? String(body.agentId) : ""
      const existing = await db.query(
        `select id from drive_agents where runtime_instance_id=$1 or ($2::uuid is not null and id=$2::uuid) order by runtime_instance_id=$1 desc limit 1`,
        [instanceId, requestedAgentId || null]
      )
      const agentId = existing.rows[0]?.id || crypto.randomUUID()
      const capabilities = Array.isArray(body.capabilities) ? body.capabilities : []
      if (existing.rows[0]) {
        await db.query(
          `update drive_agents set runtime_instance_id=$2,status='online',last_heartbeat_at=now(),last_seen_host=$3,last_seen_version=$4,capabilities=$5::jsonb,metadata=coalesce(metadata,'{}'::jsonb)||'{"temporaryRuntime":true}'::jsonb,updated_at=now(),last_error=null where id=$1`,
          [agentId, instanceId, String(body.host || "").slice(0, 255) || null, String(body.version || "").slice(0, 80) || null, JSON.stringify(capabilities)]
        )
      } else {
        await db.query(
          `insert into drive_agents(id,name,category,provider,status,capabilities,runtime_instance_id,last_heartbeat_at,last_seen_host,last_seen_version,metadata,created_at,updated_at) values($1,$2,'worker','self_hosted','online',$3::jsonb,$4,now(),$5,$6,'{"temporaryRuntime":true}'::jsonb,now(),now())`,
          [agentId, String(body.name || "Temporary migration worker").slice(0, 255), JSON.stringify(capabilities), instanceId, String(body.host || "").slice(0, 255) || null, String(body.version || "").slice(0, 80) || null]
        )
      }
      return json({ ok: true, agentId })
    })
  }
  const match = /^\/workers\/([0-9a-f-]{36})(?:\/(heartbeat|claim-job|jobs\/([0-9a-f-]{36})))?$/i.exec(path)
  if (!match) return json({ error: "Not found" }, 404)
  return database(env, async (db) => {
    const agent = await workerAuthorized(db, match[1], body.token)
    if (!agent) return json({ error: "Invalid worker secret" }, 401)
    const action = match[2] || "register"
    const now = new Date().toISOString()
    if (action === "register" || action === "heartbeat") {
      await db.query(`update drive_agents set status='online',last_heartbeat_at=now(),last_seen_host=$2,last_seen_version=$3,capabilities=case when jsonb_array_length($4::jsonb)>0 then $4::jsonb else capabilities end,metadata=coalesce(metadata,'{}'::jsonb)||$5::jsonb,updated_at=now(),last_error=null where id=$1 and status<>'disabled'`, [agent.id, String(body.host || "").slice(0, 255) || null, String(body.version || "").slice(0, 80) || null, JSON.stringify(Array.isArray(body.capabilities) ? body.capabilities : []), JSON.stringify(body.metadata && typeof body.metadata === "object" ? body.metadata : {})])
      return json({ ok: true, agentId: agent.id })
    }
    if (action === "claim-job") {
      const migrationId = typeof body.migrationId === "string" ? body.migrationId : ""
      if (!migrationId || body.pool !== true) return json({ error: "Migration worker claims require a pool migration id" }, 409)
      if (!Array.isArray(agent.capabilities) || !agent.capabilities.includes("bulk_migrate")) return json({ error: "Worker is not registered for bulk migrations" }, 409)
      await db.query("begin")
      try {
        const candidate = await db.query(`select * from drive_repair_jobs where migration_id=$1 and status='pending' and work_key like 'migration:%:generation:%:inventory:%' order by created_at for update skip locked limit 1`, [migrationId])
        const job = candidate.rows[0]
        if (!job) { await db.query("commit"); return json({ ok: true, job: null }) }
        const claimed = await db.query(`update drive_repair_jobs set status='running',claimed_by_agent_id=$2,claim_token=gen_random_uuid(),claimed_at=now(),started_at=coalesce(started_at,now()),last_heartbeat_at=now(),summary=$3,payload=coalesce(payload,'{}'::jsonb)||jsonb_build_object('claimedWorkerInstanceId',$4::text),updated_at=now() where id=$1 returning *`, [job.id, agent.id, `Claimed by ${agent.name}`, typeof body.workerInstanceId === "string" ? body.workerInstanceId : null])
        if (typeof body.workerInstanceId === "string") await db.query(`update drive_agent_runs set job_reference=$2,status='running',updated_at=now() where agent_id=$1 and payload->>'workerInstanceId'=$3 and status in('pending','running')`, [agent.id, job.id, body.workerInstanceId])
        await db.query("commit")
        const claimedJob = claimed.rows[0]
        return json({ ok: true, job: { id: claimedJob.id, migrationId, mode: claimedJob.mode, payload: claimedJob.payload || {} }, payload: await workerPayload(db, claimedJob) })
      } catch (error) { await db.query("rollback").catch(() => undefined); throw error }
    }
    const jobId = match[3]
    const current = (await db.query(`select * from drive_repair_jobs where id=$1 and claimed_by_agent_id=$2 limit 1`, [jobId, agent.id])).rows[0]
    if (!current) return json({ error: "This job is no longer owned by this worker" }, 409)
    if (current.status === "canceled") return json({ ok: true, canceled: true, job: current })
    const status = ["pending", "claimed", "running", "completed", "failed", "canceled"].includes(String(body.status)) ? String(body.status) : current.status
    const updated = await db.query(`update drive_repair_jobs set status=$3,progress=coalesce(progress,'{}'::jsonb)||$4::jsonb,result=coalesce(result,'{}'::jsonb)||$5::jsonb,summary=coalesce($6,summary),error=coalesce($7,error),last_heartbeat_at=now(),completed_at=case when $3 in ('completed','failed','canceled') then now() else completed_at end,updated_at=now() where id=$1 and claimed_by_agent_id=$2 returning *`, [jobId, agent.id, status, JSON.stringify(body.progress && typeof body.progress === "object" ? body.progress : {}), JSON.stringify(body.result && typeof body.result === "object" ? body.result : {}), typeof body.summary === "string" ? body.summary.slice(0, 2000) : null, typeof body.error === "string" ? body.error.slice(0, 4000) : null])
    await db.query(`update drive_agents set last_heartbeat_at=now(),status=case when $2 in ('completed','failed','canceled') then 'offline' else 'online' end,updated_at=now() where id=$1`, [agent.id, status])
    return json({ ok: true, job: updated.rows[0] })
  })
}
async function cycle(env: Env) {
  return database(env, async (db) => {
    const owner = crypto.randomUUID()
    if (!(await acquire(db, owner))) return { ok: true, skipped: "cycle_already_running" }
    let migrationId: string | null = null
    try {
      const setting = await db.query(`select value from drive_app_settings where key='migration-orchestrator' limit 1`)
      if (setting.rows[0]?.value?.migrationEnabled !== true && setting.rows[0]?.value?.enabled !== true) return complete(db, owner, null, { ok: true, skipped: "disabled" })
      const migration = await selectMigration(db)
      if (!migration) return complete(db, owner, null, { ok: true, idle: true })
      migrationId = migration.id
      const shards = await ensureShards(db, migration)
      const recovered = shards.inventoryPending || shards.queuePending ? 0 : await recoverJobs(db, migration.id, shards.generation, shards.shardCount)
      await renew(db, owner)
      const finalized = shards.terminalFailure || shards.inventoryPending || shards.queuePending
        ? { complete: false, terminalFailure: Boolean(shards.terminalFailure), jobs: {} }
        : await finalizeShards(db, migration, shards.generation, shards.shardCount)
      const verification = finalized.complete ? await finishOrRepair(db, migration, shards.generation) : { verification: "waiting_for_shards" }
      await renew(db, owner)
      const fileScanner = shards.inventoryPending || (finalized.complete && verification.verification === "pending") ? await wakeFileScanner(db) : "not_needed"
      const current = (await db.query(`select * from drive_migrations where id=$1`, [migration.id])).rows[0]
      // Once scanning is complete and the first durable file jobs exist, the
      // fleet can begin consuming while later inventory pages are still being
      // materialized. Pool-state polling keeps runners alive until every page
      // is queued, so this does not create a completion race.
      const hasRunnableFiles = shards.shardCount > 0 || shards.created > 0
      const dispatched = current?.status === "running" && !shards.inventoryPending && hasRunnableFiles ? await dispatchWorkers(db, env, current) : 0
      if (shards.inventoryPending || shards.queuePending) await env.GITHUB_DISPATCH_QUEUE.send({ control: "cycle" })
      await db.query(`update drive_migrations set last_synced_at=now(),updated_at=now() where id=$1 and status in('running','verifying')`, [migration.id])
      return complete(db, owner, migration.id, { ok: true, migrationId, ...shards, recovered, finalized, ...verification, fileScanner, dispatched })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await db.query(`update drive_migration_orchestrator_state set status='error',lease_owner=null,lease_expires_at=null,last_completed_at=now(),last_error=$1,last_migration_id=$2,last_result=$3::jsonb,updated_at=now() where id=true and lease_owner=$4`, [message, migrationId, JSON.stringify({ ok: false, error: message }), owner]).catch(() => undefined)
      throw error
    }
  })
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/workers/") && request.method === "POST") {
      try { return await workerRequest(request, env, url.pathname) } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 503) }
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "migration-orchestrator", build: BUILD })
    }
    if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401)
    if (url.pathname === "/status" && request.method === "GET") return json(await database(env, async (db) => { const row = await db.query(`select * from drive_migration_orchestrator_state where id=true`); return { ok: true, service: "migration-orchestrator", build: BUILD, state: row.rows[0] || null } }))
    if (url.pathname === "/run" && request.method === "POST") { try { return json(await cycle(env)) } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 503) } }
    return json({ error: "Not found" }, 404)
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) { ctx.waitUntil(cycle(env).then(() => undefined).catch((error) => console.error(error))) },
  async queue(batch: MessageBatch<DispatchMessage>, env: Env) {
    for (const message of batch.messages) {
      try {
        if ("control" in message.body) {
          const result = await cycle(env)
          if (result?.skipped === "cycle_already_running") message.retry({ delaySeconds: 2 })
          else message.ack()
          continue
        }
        const outcome = await consumeDispatch(env, message.body.intentId, message.attempts)
        if (outcome === "accepted" || outcome === "awaiting_reconciliation") message.retry({ delaySeconds: 30 })
        else message.ack()
      } catch (error) {
        console.error("GitHub dispatch message failed", "intentId" in message.body ? message.body.intentId : message.body.control, error)
        message.retry({ delaySeconds: Math.min(30 * (2 ** Math.min(message.attempts, 10)), 3600) })
      }
    }
  },
}
