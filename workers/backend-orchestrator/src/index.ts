import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"
import { Client } from "pg"

type Env = {
  PANEL_URL: string
  PANEL_SHARED_SECRET: string
  POSTGRES_URL: string
  SYNC_INTERVAL_MINUTES: string
  PAGES_PER_RUN: string
  API_EVENTS_RETENTION_DAYS: string
  OBJECT_CHANGES_RETENTION_DAYS: string
  SCAN_DETAILS_RETENTION_DAYS: string
}

type RuntimeConfig = {
  version: number
  postgresUrl: string
  syncIntervalMinutes: number
  pagesPerRun: number
  retention: { apiEventsDays: number; objectChangesDays: number; scanDetailsDays: number }
}

type AccountRow = {
  id: string
  label: string
  email: string
  api_token: string
  r2_access_key_id: string
  r2_secret_access_key: string
  cloudflare_account_id: string | null
  status: string
  last_synced_at: string | null
}

type ScanRow = {
  id: string
  account_id: string
  bucket_name: string
  last_key: string | null
  objects: string | number
  bytes: string | number
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } })
}

function panelUrl(env: Env, path: string) {
  return `${env.PANEL_URL.trim().replace(/\/$/, "")}${path}`
}

function authorized(request: Request, env: Env) {
  const header = request.headers.get("authorization") ?? ""
  return header.startsWith("Bearer ") && header.slice(7).trim() === env.PANEL_SHARED_SECRET.trim()
}

function boundedInteger(value: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback
}

function runtimeConfig(env: Env): RuntimeConfig {
  if (!env.POSTGRES_URL?.trim()) throw new Error("POSTGRES_URL was not injected during deployment")
  return {
    version: 2,
    postgresUrl: env.POSTGRES_URL.trim(),
    syncIntervalMinutes: boundedInteger(env.SYNC_INTERVAL_MINUTES, 1, 1, 60),
    pagesPerRun: boundedInteger(env.PAGES_PER_RUN, 5, 1, 20),
    retention: {
      apiEventsDays: boundedInteger(env.API_EVENTS_RETENTION_DAYS, 7, 1, 365),
      objectChangesDays: boundedInteger(env.OBJECT_CHANGES_RETENTION_DAYS, 7, 1, 365),
      scanDetailsDays: boundedInteger(env.SCAN_DETAILS_RETENTION_DAYS, 7, 1, 365),
    },
  }
}

function dbClient(connectionString: string) {
  return new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
    statement_timeout: 20_000,
  })
}

async function ensureSchema(db: Client) {
  await db.query(`
    create table if not exists drive_backend_orchestrator_state (
      id boolean primary key default true check (id),
      status text not null default 'idle',
      orchestrator_url text,
      last_started_at timestamptz,
      last_completed_at timestamptz,
      last_error text,
      last_result jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    )
  `)
  await db.query(`
    create table if not exists drive_bucket_stat_history (
      id bigint generated always as identity primary key,
      account_id uuid not null,
      account_label text,
      account_email text,
      bucket_name text not null,
      previous_objects bigint,
      objects bigint not null default 0,
      object_delta bigint not null default 0,
      previous_bytes bigint,
      bytes bigint not null default 0,
      byte_delta bigint not null default 0,
      change_type text not null,
      changed_at timestamptz not null default now()
    )
  `)
  await db.query(`create index if not exists drive_bucket_stat_history_bucket_time_idx on drive_bucket_stat_history (account_id, bucket_name, changed_at desc)`)
  await db.query(`create index if not exists drive_bucket_stat_history_time_idx on drive_bucket_stat_history (changed_at desc)`)
  await db.query(`
    create table if not exists drive_analytics_bucket_snapshots (
      account_id uuid not null,
      account_label text,
      account_email text,
      bucket_name text not null,
      objects bigint not null default 0,
      bytes bigint not null default 0,
      status text,
      source_updated_at timestamptz,
      captured_at timestamptz not null default now(),
      primary key (account_id, bucket_name)
    )
  `)
  await db.query(`
    create table if not exists drive_maintenance_state (
      task_name text primary key,
      last_run_at timestamptz not null default now(),
      last_result jsonb not null default '{}'::jsonb
    )
  `)
}

async function setState(db: Client, input: { status: string; orchestratorUrl?: string; error?: string | null; result?: unknown; completed?: boolean }) {
  await db.query(
    `
      insert into drive_backend_orchestrator_state
        (id, status, orchestrator_url, last_started_at, last_completed_at, last_error, last_result, updated_at)
      values (true, $1, $2, now(), case when $5 then now() else null end, $3, $4::jsonb, now())
      on conflict (id) do update set
        status = excluded.status,
        orchestrator_url = coalesce(excluded.orchestrator_url, drive_backend_orchestrator_state.orchestrator_url),
        last_started_at = case when excluded.status = 'running' then now() else drive_backend_orchestrator_state.last_started_at end,
        last_completed_at = case when $5 then now() else drive_backend_orchestrator_state.last_completed_at end,
        last_error = excluded.last_error,
        last_result = excluded.last_result,
        updated_at = now()
    `,
    [input.status, input.orchestratorUrl ?? null, input.error ?? null, JSON.stringify(input.result ?? {}), input.completed === true]
  )
}

async function resolveCloudflareAccount(account: AccountRow) {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts", {
    headers: { Authorization: `Bearer ${account.api_token}` },
  })
  const payload = await response.json().catch(() => ({})) as { result?: unknown; errors?: Array<{ message?: string }> }
  if (!response.ok) throw new Error(payload.errors?.[0]?.message || `Cloudflare account lookup failed (${response.status})`)
  const result = Array.isArray(payload.result) ? payload.result[0] : payload.result
  if (!result || typeof result !== "object" || !("id" in result)) throw new Error(`No Cloudflare account found for ${account.label}`)
  return { id: String((result as { id: unknown }).id), name: String((result as { name?: unknown }).name ?? account.label) }
}

async function listBuckets(account: AccountRow) {
  if (!account.cloudflare_account_id) throw new Error(`Account ${account.label} has no Cloudflare account ID`)
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.cloudflare_account_id)}/r2/buckets`, {
    headers: { Authorization: `Bearer ${account.api_token}` },
  })
  const payload = await response.json().catch(() => ({})) as { result?: unknown; errors?: Array<{ message?: string }> }
  if (!response.ok) throw new Error(payload.errors?.[0]?.message || `R2 bucket listing failed (${response.status})`)
  const result = payload.result
  const values = Array.isArray(result) ? result : result && typeof result === "object" && Array.isArray((result as { buckets?: unknown }).buckets) ? (result as { buckets: unknown[] }).buckets : []
  return values.map((value) => String((value as { name?: unknown })?.name ?? "")).filter(Boolean)
}

async function recordBucketHistory(db: Client, input: { accountId: string; bucket: string; objects: number; bytes: number; deleted: boolean }) {
  await db.query(
    `
      with latest as (
        select objects, bytes, change_type from drive_bucket_stat_history
        where account_id = $1 and bucket_name = $2 order by changed_at desc, id desc limit 1
      ), account as (
        select label, email from drive_accounts where id = $1
      ), inserted as (
        insert into drive_bucket_stat_history (
          account_id, account_label, account_email, bucket_name,
          previous_objects, objects, object_delta, previous_bytes, bytes, byte_delta, change_type
        )
        select $1, account.label, account.email, $2,
               latest.objects, $3, $3 - coalesce(latest.objects, 0),
               latest.bytes, $4, $4 - coalesce(latest.bytes, 0),
               case when $5 then 'deleted' when latest.objects is null then 'created' else 'changed' end
        from account left join latest on true
        where latest.objects is null or latest.objects is distinct from $3 or latest.bytes is distinct from $4
           or ($5::boolean and latest.change_type <> 'deleted')
        returning account_id, account_label, account_email, bucket_name, objects, bytes, change_type, changed_at
      )
      insert into drive_analytics_bucket_snapshots
        (account_id, account_label, account_email, bucket_name, objects, bytes, status, source_updated_at, captured_at)
      select account_id, account_label, account_email, bucket_name, objects, bytes,
             case when change_type='deleted' then 'deleted' else 'completed' end, changed_at, changed_at
      from inserted
      on conflict (account_id, bucket_name) do update set
        account_label=excluded.account_label, account_email=excluded.account_email,
        objects=excluded.objects, bytes=excluded.bytes, status=excluded.status,
        source_updated_at=excluded.source_updated_at, captured_at=excluded.captured_at
    `,
    [input.accountId, input.bucket, input.objects, input.bytes, input.deleted]
  )
}

async function reconcileBuckets(db: Client, account: AccountRow, bucketNames: string[]) {
  const current = await db.query<{ id: string; bucket_name: string; objects: string; bytes: string }>(
    `select id, bucket_name, objects, bytes from drive_bucket_stats where account_id=$1`, [account.id]
  )
  const names = new Set(bucketNames)
  for (const row of current.rows.filter((row) => !names.has(row.bucket_name))) {
    await recordBucketHistory(db, { accountId: account.id, bucket: row.bucket_name, objects: 0, bytes: 0, deleted: true })
    await db.query(`delete from drive_bucket_stats where id=$1`, [row.id])
  }
  for (const bucket of bucketNames) {
    await db.query(
      `insert into drive_bucket_stats (id,account_id,bucket_name,objects,bytes,status,updated_at)
       values (gen_random_uuid(),$1,$2,0,0,'pending',now())
       on conflict (account_id,bucket_name) do nothing`,
      [account.id, bucket]
    )
  }
}

async function selectAccountAndScan(db: Client, syncIntervalMinutes: number) {
  const running = await db.query<ScanRow & { account_label: string; account_email: string; api_token: string; r2_access_key_id: string; r2_secret_access_key: string; cloudflare_account_id: string | null; account_status: string; last_synced_at: string | null }>(`
    select s.id,s.account_id,s.bucket_name,s.last_key,s.objects,s.bytes,
           a.label account_label,a.email account_email,a.api_token,a.r2_access_key_id,a.r2_secret_access_key,
           a.cloudflare_account_id,a.status account_status,a.last_synced_at
    from drive_bucket_scans s join drive_accounts a on a.id=s.account_id
    where s.kind='orchestrator' and s.status='running'
    order by s.updated_at asc limit 1
  `)
  if (running.rows[0]) {
    const row = running.rows[0]
    return {
      account: {
        id: row.account_id, label: row.account_label, email: row.account_email, api_token: row.api_token,
        r2_access_key_id: row.r2_access_key_id, r2_secret_access_key: row.r2_secret_access_key,
        cloudflare_account_id: row.cloudflare_account_id, status: row.account_status, last_synced_at: row.last_synced_at,
      },
      scan: { id: row.id, account_id: row.account_id, bucket_name: row.bucket_name, last_key: row.last_key, objects: row.objects, bytes: row.bytes },
    }
  }
  const account = await db.query<AccountRow>(`
    select id,label,email,api_token,r2_access_key_id,r2_secret_access_key,cloudflare_account_id,status,last_synced_at
    from drive_accounts
    where api_token<>'' and r2_access_key_id<>'' and r2_secret_access_key<>''
      and (last_synced_at is null or last_synced_at < now() - ($1::text || ' minutes')::interval)
    order by last_synced_at asc nulls first, created_at asc limit 1
  `, [syncIntervalMinutes])
  return { account: account.rows[0] ?? null, scan: null as ScanRow | null }
}

async function createNextScan(db: Client, accountId: string, bucketNames: string[]) {
  if (bucketNames.length === 0) return null
  const next = await db.query<{ bucket_name: string }>(
    `select bucket_name from drive_bucket_stats where account_id=$1 and bucket_name=any($2::text[])
     order by updated_at asc nulls first, bucket_name asc limit 1`,
    [accountId, bucketNames]
  )
  const bucket = next.rows[0]?.bucket_name
  if (!bucket) return null
  const inserted = await db.query<ScanRow>(
    `insert into drive_bucket_scans (id,account_id,bucket_name,kind,status,objects,bytes,started_at,updated_at)
     values (gen_random_uuid(),$1,$2,'orchestrator','running',0,0,now(),now()) returning id,account_id,bucket_name,last_key,objects,bytes`,
    [accountId, bucket]
  )
  return inserted.rows[0]
}

async function completeScan(db: Client, account: AccountRow, scan: ScanRow, objects: number, bytes: number) {
  await db.query("begin")
  try {
    await recordBucketHistory(db, { accountId: account.id, bucket: scan.bucket_name, objects, bytes, deleted: false })
    await db.query(
      `update drive_bucket_stats set objects=$3,bytes=$4,continuation_token=null,status='completed',error=null,updated_at=now()
       where account_id=$1 and bucket_name=$2`,
      [account.id, scan.bucket_name, objects, bytes]
    )
    await db.query(`update drive_bucket_scans set status='completed',objects=$2,bytes=$3,last_key=null,completed_at=now(),updated_at=now() where id=$1`, [scan.id, objects, bytes])
    await db.query(`
      update drive_accounts a set
        total_buckets=(select count(*) from drive_bucket_stats s where s.account_id=a.id),
        total_objects=(select coalesce(sum(objects),0) from drive_bucket_stats s where s.account_id=a.id),
        total_bytes=(select coalesce(sum(bytes),0) from drive_bucket_stats s where s.account_id=a.id),
        sync_status='ok',sync_message='Backend Orchestrator sync completed',last_synced_at=now(),updated_at=now()
      where a.id=$1
    `, [account.id])
    await db.query("commit")
  } catch (error) {
    await db.query("rollback")
    throw error
  }
}

async function scanPages(db: Client, account: AccountRow, scan: ScanRow, pagesPerRun: number) {
  if (!account.cloudflare_account_id) throw new Error("Cloudflare account ID is missing")
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${account.cloudflare_account_id}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: account.r2_access_key_id, secretAccessKey: account.r2_secret_access_key },
  })
  let token = scan.last_key ?? undefined
  let objects = Number(scan.objects) || 0
  let bytes = Number(scan.bytes) || 0
  let pages = 0
  while (pages < pagesPerRun) {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: scan.bucket_name, ContinuationToken: token, MaxKeys: 1000 }))
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue
      objects += 1
      bytes += Number(object.Size ?? 0)
    }
    pages += 1
    token = page.NextContinuationToken
    await db.query(`update drive_bucket_scans set objects=$2,bytes=$3,last_key=$4,updated_at=now() where id=$1`, [scan.id, objects, bytes, token ?? null])
    if (!token) {
      await completeScan(db, account, scan, objects, bytes)
      return { bucket: scan.bucket_name, status: "completed", objects, bytes, pages }
    }
  }
  return { bucket: scan.bucket_name, status: "running", objects, bytes, pages }
}

async function syncNextAccount(db: Client, config: RuntimeConfig) {
  const selected = await selectAccountAndScan(db, config.syncIntervalMinutes)
  if (!selected.account) return { status: "idle", message: "No account is due for synchronization" }
  const account = selected.account
  try {
    if (!account.cloudflare_account_id) {
      const resolved = await resolveCloudflareAccount(account)
      account.cloudflare_account_id = resolved.id
      await db.query(`update drive_accounts set cloudflare_account_id=$2,cloudflare_account_name=$3,updated_at=now() where id=$1`, [account.id, resolved.id, resolved.name])
    }
    await db.query(`update drive_accounts set sync_status='syncing',sync_message='Backend Orchestrator scan running',updated_at=now() where id=$1`, [account.id])
    const buckets = await listBuckets(account)
    await reconcileBuckets(db, account, buckets)
    let scan = selected.scan
    if (scan && !buckets.includes(scan.bucket_name)) {
      await db.query(`update drive_bucket_scans set status='failed',error='Bucket deleted during scan',completed_at=now(),updated_at=now() where id=$1`, [scan.id])
      scan = null
    }
    scan = scan ?? await createNextScan(db, account.id, buckets)
    if (!scan) {
      await db.query(`update drive_accounts set total_buckets=0,total_objects=0,total_bytes=0,sync_status='ok',sync_message='No R2 buckets',last_synced_at=now(),updated_at=now() where id=$1`, [account.id])
      return { account: account.label, status: "completed", buckets: 0 }
    }
    return { account: account.label, ...(await scanPages(db, account, scan, config.pagesPerRun)) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.query(`update drive_accounts set sync_status='error',sync_message=$2,updated_at=now() where id=$1`, [account.id, message]).catch(() => undefined)
    throw error
  }
}

async function runRetention(db: Client, config: RuntimeConfig) {
  const claim = await db.query(`
    insert into drive_maintenance_state(task_name,last_run_at) values('backend-orchestrator-retention',now())
    on conflict(task_name) do update set last_run_at=excluded.last_run_at
    where drive_maintenance_state.last_run_at<now()-interval '6 hours' returning task_name
  `)
  if (claim.rowCount === 0) return false
  await db.query(`delete from drive_project_api_events where occurred_at<now()-($1::text||' days')::interval`, [config.retention.apiEventsDays])
  await db.query(`delete from drive_object_change_events where occurred_at<now()-($1::text||' days')::interval`, [config.retention.objectChangesDays])
  await db.query(`delete from drive_bucket_scan_objects where created_at<now()-($1::text||' days')::interval`, [config.retention.scanDetailsDays])
  await db.query(`delete from drive_bucket_verify_diffs where created_at<now()-($1::text||' days')::interval`, [config.retention.scanDetailsDays])
  await db.query(`delete from drive_bucket_scans where status in('completed','failed') and coalesce(completed_at,updated_at)<now()-($1::text||' days')::interval`, [config.retention.scanDetailsDays])
  return true
}

async function reconcilePanel(env: Env) {
  const response = await fetch(panelUrl(env, "/api/internal/backend-orchestrator/reconcile"), {
    method: "POST",
    headers: { Authorization: `Bearer ${env.PANEL_SHARED_SECRET}` },
  })
  if (!response.ok) throw new Error(`Panel reconciliation failed (${response.status})`)
  return response.json()
}

async function runCycle(env: Env, orchestratorUrl?: string) {
  const config = runtimeConfig(env)
  const db = dbClient(config.postgresUrl)
  await db.connect()
  let locked = false
  try {
    await ensureSchema(db)
    const lock = await db.query<{ locked: boolean }>(`select pg_try_advisory_lock(hashtext('drive-backend-orchestrator')) locked`)
    locked = lock.rows[0]?.locked === true
    if (!locked) return { ok: true, skipped: "Another Backend Orchestrator cycle is active" }
    await setState(db, { status: "running", orchestratorUrl })
    const sync = await syncNextAccount(db, config)
    const maintenance = await runRetention(db, config)
    const panel = await reconcilePanel(env).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    const result = { sync, maintenance, panel }
    await setState(db, { status: "idle", result, completed: true })
    return { ok: true, result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await setState(db, { status: "error", error: message, result: { error: message }, completed: true }).catch(() => undefined)
    throw error
  } finally {
    if (locked) await db.query(`select pg_advisory_unlock(hashtext('drive-backend-orchestrator'))`).catch(() => undefined)
    await db.end().catch(() => undefined)
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      let db: Client | null = null
      try {
        const config = runtimeConfig(env)
        db = dbClient(config.postgresUrl)
        await db.connect()
        await db.query("select 1")
        return json({ ok: true, configured: true, panel: new URL(env.PANEL_URL).origin })
      } catch {
        return json({ ok: false, configured: false }, 503)
      } finally {
        await db?.end().catch(() => undefined)
      }
    }
    if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401)
    if (url.pathname === "/run" && request.method === "POST") {
      try { return json(await runCycle(env, url.origin)) } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 500) }
    }
    if (url.pathname === "/status" && request.method === "GET") {
      let db: Client | null = null
      try {
        const config = runtimeConfig(env)
        db = dbClient(config.postgresUrl)
        await db.connect()
        await ensureSchema(db)
        const state = await db.query(`select * from drive_backend_orchestrator_state where id=true limit 1`)
        return json({ ok: true, state: state.rows[0] ?? null })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500)
      } finally {
        await db?.end().catch(() => undefined)
      }
    }
    void ctx
    return json({ error: "Not found" }, 404)
  },
  async scheduled(_controller, env, _ctx): Promise<void> {
    await runCycle(env)
  },
} satisfies ExportedHandler<Env>
