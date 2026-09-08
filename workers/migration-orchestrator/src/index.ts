import { Client } from "pg"

type Env = { POSTGRES_URL?: string }
type Row = Record<string, any>
const BUILD = 2
const MAX_SECRET_LENGTH = 512
let authCache: { value: string; expiresAt: number } | null = null

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
  if (authCache && authCache.expiresAt > Date.now()) return safeEqual(supplied, authCache.value)
  return database(env, async (db) => {
    const result = await db.query(`select value->>'sharedSecret' secret from drive_app_settings where key='migration-orchestrator' limit 1`)
    const expected = String(result.rows[0]?.secret || "")
    if (expected.length >= 24 && expected.length <= MAX_SECRET_LENGTH) authCache = { value: expected, expiresAt: Date.now() + 30_000 }
    return expected.length >= 24 && expected.length <= MAX_SECRET_LENGTH && safeEqual(supplied, expected)
  }).catch(() => false)
}
async function database<T>(env: Env, operation: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = String(env.POSTGRES_URL || "").trim()
  if (!connectionString) throw new Error("POSTGRES_URL is not configured")
  const hostname = new URL(connectionString).hostname
  const client = new Client({ connectionString, ssl: ["localhost", "127.0.0.1"].includes(hostname) ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 8_000 })
  await client.connect()
  try { return await operation(client) } finally { await client.end().catch(() => undefined) }
}
async function ensureSchema(db: Client) {
  await db.query(`
    create table if not exists drive_migration_orchestrator_state (
      id boolean primary key default true check (id), status text not null default 'idle', orchestrator_url text,
      last_started_at timestamptz, last_completed_at timestamptz, last_error text,
      last_migration_id uuid references drive_migrations(id) on delete set null,
      last_result jsonb not null default '{}'::jsonb, cycle_count bigint not null default 0, updated_at timestamptz not null default now()
    );
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
    insert into drive_migration_orchestrator_state(id,status,lease_owner,last_started_at,last_error,updated_at)
    values(true,'running',$1,now(),null,now())
    on conflict(id) do update set status='running',lease_owner=$1,last_started_at=now(),last_error=null,updated_at=now()
      where drive_migration_orchestrator_state.status<>'running' or drive_migration_orchestrator_state.last_started_at<now()-interval '150 seconds'
    returning id
  `, [owner])
  return result.rowCount === 1
}
async function selectMigration(db: Client): Promise<Row | null> {
  const result = await db.query(`select * from drive_migrations where status in ('running','verifying') and options->>'executionMode'='migration_workers' order by coalesce(last_synced_at,created_at),created_at limit 1`)
  return result.rows[0] || null
}
async function ensureShards(db: Client, migration: Row) {
  const generation = integer(opts(migration).workerGeneration, 1, 1, 1000000)
  const shardCount = integer(opts(migration).workerShardCount, 32, 1, 128)
  const items = await db.query(`select id from drive_migration_items where migration_id=$1 and coalesce(slurper_status,'')<>'worker_bucket_create_failed' order by created_at`, [migration.id])
  const itemIds = items.rows.map((row) => row.id)
  if (!itemIds.length) {
    await db.query(`update drive_migrations set status='failed',sync_status='failed',sync_message='No migration buckets are available for worker processing',last_synced_at=now(),updated_at=now() where id=$1`, [migration.id])
    return { generation, shardCount: 0, created: 0, terminalFailure: true }
  }
  const inserted = await db.query(`
    insert into drive_repair_jobs(id,migration_id,status,mode,work_key,payload,progress,result,created_at,updated_at)
    select gen_random_uuid(),$1,'pending','repair_and_verify',format('migration:%s:generation:%s:shard:%s/%s',$1::text,$2::int,g.i,$3::int),
      jsonb_build_object('source','migration_orchestrator','kind','migration_shard','workerGeneration',$2::int,'workerShard',jsonb_build_object('index',g.i,'count',$3::int),'itemIds',$4::jsonb,'items',(select jsonb_agg(jsonb_build_object('id',v)) from jsonb_array_elements_text($4::jsonb) v)),
      '{}'::jsonb,'{}'::jsonb,now(),now() from generate_series(0,$3::int-1) g(i)
    on conflict(work_key) where work_key is not null do nothing
  `, [migration.id, generation, shardCount, JSON.stringify(itemIds)])
  return { generation, shardCount, created: inserted.rowCount || 0 }
}
async function recoverJobs(db: Client, migrationId: string, generation: number, shardCount: number) {
  const result = await db.query(`
    update drive_repair_jobs set status='pending',claimed_by_agent_id=null,claim_token=null,claimed_at=null,started_at=null,last_heartbeat_at=null,error=null,
      summary='Recovered by Migration Orchestrator',result=jsonb_set(coalesce(result,'{}'::jsonb),'{retryCount}',to_jsonb(coalesce((result->>'retryCount')::int,0)+1)),updated_at=now()
    where migration_id=$1 and work_key like $2 and work_key like $3 and ((status='failed' and coalesce((result->>'retryCount')::int,0)<3) or (status in('claimed','running') and coalesce(last_heartbeat_at,started_at,claimed_at,updated_at)<now()-interval '3 minutes'))
  `, [migrationId, `migration:${migrationId}:generation:${generation}:shard:%`, `%/${shardCount}`])
  return result.rowCount || 0
}
async function finalizeShards(db: Client, migration: Row, generation: number, shardCount: number) {
  const counts = await db.query(`select status,count(*)::int count from drive_repair_jobs where migration_id=$1 and work_key like $2 and work_key like $3 group by status`, [migration.id, `migration:${migration.id}:generation:${generation}:shard:%`, `%/${shardCount}`])
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
    const attempts = integer(opts(migration).workerVerificationRepairAttempts, 0, 0, 100)
    if (attempts >= 2) {
      await db.query(`update drive_migrations set status='failed',sync_status='failed',sync_message=$2,updated_at=now() where id=$1`, [migration.id, `Independent verification failed: ${missing} missing, ${mismatched} mismatched, ${extra} extra`])
      return { verification: "failed", missing, mismatched, extra }
    }
    const next = { ...opts(migration), workerGeneration: generation + 1, workerVerificationRepairAttempts: attempts + 1 }
    await db.query(`update drive_migrations set status='running',options=$2::jsonb,sync_status='running',sync_message='Verification issues queued for repair',updated_at=now() where id=$1`, [migration.id, JSON.stringify(next)])
    await db.query(`update drive_migration_items set slurper_status='running',updated_at=now() where migration_id=$1`, [migration.id])
    return { verification: "repair_queued", missing, mismatched, extra, generation: generation + 1 }
  }
  const settings = await syncNextBucketSettings(db, migration)
  if (settings.settings !== "synced") return { verification: settings.settings === "failed" ? "failed" : "settings_sync", missing, mismatched, extra, ...settings }
  await db.query("begin")
  try {
    await db.query(`update drive_accounts set status=case when id=$1 then 'active' when status='active' then 'available' else status end,last_migrated=case when id=$1 then to_char(now(),'YYYY-MM-DD HH24:MI:SS') else last_migrated end,updated_at=now() where id=$1 or status='active'`, [migration.target_account_id])
    await db.query(`update drive_migrations set status='completed',completed_at=now(),sync_status='synced',sync_message='Migration independently verified',last_synced_at=now(),updated_at=now(),summary_item_count=(select count(*) from drive_migration_items where migration_id=$1),summary_objects=(select coalesce(sum(source_objects),0) from drive_migration_items where migration_id=$1),summary_bytes=(select coalesce(sum(source_bytes),0) from drive_migration_items where migration_id=$1) where id=$1`, [migration.id])
    await db.query("commit")
  } catch (error) { await db.query("rollback"); throw error }
  return { verification: "completed", missing, mismatched, extra, backendOrchestrator: await wakeBackendOrchestrator(db) }
}
async function dispatchWorkers(db: Client, migration: Row) {
  const ids = Array.isArray(opts(migration).workerAgentIds) ? opts(migration).workerAgentIds.filter((id: unknown) => typeof id === "string") : []
  const configRows = await db.query(`select key,value from drive_app_settings where key='migration-orchestrator'`)
  const orchestration = configRows.rows.find((row) => row.key === "migration-orchestrator")?.value || {}
  if (!ids.length) return 0
  const budget = integer(orchestration.maxDispatchesPerCycle, 3, 1, 10)
  const agents = await db.query(`select id,github_repo_owner,github_repo_name,github_workflow_file,github_ref,github_token from drive_agents where id=any($1::uuid[]) and provider='github_actions' and status<>'disabled' and github_token is not null order by array_position($1::uuid[],id)`, [ids])
  let dispatched = 0
  for (const agent of agents.rows) {
    if (dispatched >= budget) break
    const active = await db.query(`
      select 1 from drive_agent_runs r join drive_agents a on a.id=r.agent_id
      where r.agent_id=$1 and r.status in('pending','running')
        and (r.updated_at>now()-interval '30 minutes' or a.last_heartbeat_at>now()-interval '2 minutes') limit 1
    `, [agent.id])
    if (active.rowCount) continue
    await db.query(`update drive_agent_runs set status='failed',summary='Recovered stale GitHub dispatch',completed_at=now(),updated_at=now() where agent_id=$1 and status in('pending','running') and payload->>'migrationId'=$2`, [agent.id, migration.id])
    const intent = await db.query(`insert into drive_agent_runs(id,agent_id,run_type,status,payload,summary,created_at,updated_at) values(gen_random_uuid(),$1,'github_dispatch','pending',$2::jsonb,'Dispatch intent created by autonomous Migration Orchestrator',now(),now()) returning id`, [agent.id, JSON.stringify({ migrationId: migration.id, pool: true, source: "migration_orchestrator", phase: "dispatching" })])
    let response: Response
    try {
      response = await fetch(`https://api.github.com/repos/${encodeURIComponent(agent.github_repo_owner)}/${encodeURIComponent(agent.github_repo_name)}/actions/workflows/${encodeURIComponent(agent.github_workflow_file || ".github/workflows/migration-worker.yml")}/dispatches`, {
        method: "POST", headers: { Authorization: `Bearer ${agent.github_token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Drive-Migration-Orchestrator" },
        body: JSON.stringify({ ref: agent.github_ref || "main", inputs: { migration_id: migration.id, agent_id: agent.id } }), signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await db.query(`update drive_agent_runs set status='failed',summary=$2,completed_at=now(),updated_at=now() where id=$1`, [intent.rows[0].id, `GitHub dispatch failed before confirmation: ${message}`])
      await db.query(`update drive_agents set last_error=$2,updated_at=now() where id=$1`, [agent.id, message])
      continue
    }
    if (!response.ok) {
      await db.query(`update drive_agent_runs set status='failed',summary=$2,completed_at=now(),updated_at=now() where id=$1`, [intent.rows[0].id, `GitHub dispatch HTTP ${response.status}`])
      await db.query(`update drive_agents set last_error=$2,updated_at=now() where id=$1`, [agent.id, `GitHub dispatch HTTP ${response.status}`]); continue
    }
    await db.query(`update drive_agent_runs set payload=payload||'{"phase":"dispatched"}'::jsonb,summary='Dispatched by autonomous Migration Orchestrator',updated_at=now() where id=$1`, [intent.rows[0].id])
    dispatched += 1
  }
  return dispatched
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
  await db.query(`update drive_migration_orchestrator_state set status='idle',lease_owner=null,last_completed_at=now(),last_error=null,last_migration_id=$1,last_result=$2::jsonb,cycle_count=cycle_count+1,updated_at=now() where id=true and lease_owner=$3`, [migrationId, JSON.stringify(result), owner])
  return result
}
async function cycle(env: Env) {
  return database(env, async (db) => {
    const owner = crypto.randomUUID()
    if (!(await acquire(db, owner))) return { ok: true, skipped: "cycle_already_running" }
    let migrationId: string | null = null
    try {
      const setting = await db.query(`select value from drive_app_settings where key='migration-orchestrator' limit 1`)
      if (setting.rows[0]?.value?.enabled !== true) return complete(db, owner, null, { ok: true, skipped: "disabled" })
      const migration = await selectMigration(db)
      if (!migration) return complete(db, owner, null, { ok: true, idle: true })
      migrationId = migration.id
      const shards = await ensureShards(db, migration)
      const recovered = await recoverJobs(db, migration.id, shards.generation, shards.shardCount)
      const finalized = shards.terminalFailure
        ? { complete: false, terminalFailure: true, jobs: {} }
        : await finalizeShards(db, migration, shards.generation, shards.shardCount)
      const verification = finalized.complete ? await finishOrRepair(db, migration, shards.generation) : { verification: "waiting_for_shards" }
      const fileScanner = finalized.complete && verification.verification === "pending" ? await wakeFileScanner(db) : "not_needed"
      const current = (await db.query(`select * from drive_migrations where id=$1`, [migration.id])).rows[0]
      const dispatched = current?.status === "running" ? await dispatchWorkers(db, current) : 0
      await db.query(`update drive_migrations set last_synced_at=now(),updated_at=now() where id=$1 and status in('running','verifying')`, [migration.id])
      return complete(db, owner, migration.id, { ok: true, migrationId, ...shards, recovered, finalized, ...verification, fileScanner, dispatched })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await db.query(`update drive_migration_orchestrator_state set status='error',lease_owner=null,last_completed_at=now(),last_error=$1,last_migration_id=$2,last_result=$3::jsonb,updated_at=now() where id=true and lease_owner=$4`, [message, migrationId, JSON.stringify({ ok: false, error: message }), owner]).catch(() => undefined)
      throw error
    }
  })
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "migration-orchestrator", build: BUILD })
    }
    if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401)
    if (url.pathname === "/status" && request.method === "GET") return json(await database(env, async (db) => { const row = await db.query(`select * from drive_migration_orchestrator_state where id=true`); return { ok: true, service: "migration-orchestrator", build: BUILD, state: row.rows[0] || null } }))
    if (url.pathname === "/run" && request.method === "POST") { try { return json(await cycle(env)) } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 503) } }
    return json({ error: "Not found" }, 404)
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) { ctx.waitUntil(cycle(env).then(() => undefined).catch((error) => console.error(error))) },
}
