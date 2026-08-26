import { Client } from "pg"

type Env = {
  PANEL_URL: string
  PANEL_SHARED_SECRET: string
  POSTGRES_URL: string
  SYNC_INTERVAL_MINUTES: string
  API_EVENTS_RETENTION_DAYS: string
  OBJECT_CHANGES_RETENTION_DAYS: string
  SCAN_DETAILS_RETENTION_DAYS: string
  DISABLE_POSTGRES_SSL: string
}

type RuntimeConfig = {
  version: number
  postgresUrl: string
  syncIntervalMinutes: number
  retention: { apiEventsDays: number; objectChangesDays: number; scanDetailsDays: number }
  disablePostgresSsl: boolean
}

type AccountRow = {
  id: string
  label: string
  email: string
  api_token: string
  cloudflare_account_id: string | null
  status: string
  last_synced_at: string | null
}

type BucketInfo = { name: string; jurisdiction: string }
type BucketMetric = { bucket: string; objects: number; bytes: number; observedAt: string }

const BUCKET_BATCH_SIZE = 25

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

function envFlag(value: string | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase()
  return normalized === "1" || normalized === "true"
}

function runtimeConfig(env: Env): RuntimeConfig {
  if (!env.POSTGRES_URL?.trim()) throw new Error("POSTGRES_URL was not injected during deployment")
  return {
    version: 2,
    postgresUrl: env.POSTGRES_URL.trim(),
    syncIntervalMinutes: boundedInteger(env.SYNC_INTERVAL_MINUTES, 1, 1, 60),
    retention: {
      apiEventsDays: boundedInteger(env.API_EVENTS_RETENTION_DAYS, 7, 1, 365),
      objectChangesDays: boundedInteger(env.OBJECT_CHANGES_RETENTION_DAYS, 7, 1, 365),
      scanDetailsDays: boundedInteger(env.SCAN_DETAILS_RETENTION_DAYS, 7, 1, 365),
    },
    disablePostgresSsl: envFlag(env.DISABLE_POSTGRES_SSL),
  }
}

function dbClient(connectionString: string, disablePostgresSsl: boolean) {
  const host = (() => {
    try { return new URL(connectionString).hostname.toLowerCase() } catch { return "" }
  })()
  const isSupabase = host.endsWith(".supabase.com")
  return new Client({
    connectionString,
    ssl: isSupabase || disablePostgresSsl ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
    statement_timeout: 20_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
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
  await db.query(`
    create table if not exists drive_backend_orchestrator_progress (
      id boolean primary key default true check (id),
      account_id uuid not null,
      bucket_names jsonb not null default '[]'::jsonb,
      bucket_offset integer not null default 0 check (bucket_offset >= 0),
      started_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `)
}

async function ensureProgressSchema(db: Client) {
  await db.query(`
    create table if not exists drive_backend_orchestrator_progress (
      id boolean primary key default true check (id),
      account_id uuid not null,
      bucket_names jsonb not null default '[]'::jsonb,
      bucket_offset integer not null default 0 check (bucket_offset >= 0),
      started_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
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
  return values
    .map((value): BucketInfo => ({
      name: String((value as { name?: unknown })?.name ?? ""),
      jurisdiction: String((value as { jurisdiction?: unknown })?.jurisdiction ?? "default"),
    }))
    .filter((value) => value.name.length > 0)
}

async function getBucketMetrics(account: AccountRow, buckets: BucketInfo[]): Promise<BucketMetric[]> {
  if (!account.cloudflare_account_id) throw new Error(`Account ${account.label} has no Cloudflare account ID`)
  const query = `
    query R2Storage($accountTag: string!, $startDate: Time!, $endDate: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2StorageAdaptiveGroups(
            limit: 10000
            filter: { datetime_geq: $startDate, datetime_leq: $endDate }
            orderBy: [datetime_DESC]
          ) {
            max { objectCount payloadSize }
            dimensions { bucketName datetime }
          }
        }
      }
    }
  `
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${account.api_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: account.cloudflare_account_id,
        startDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        endDate: new Date().toISOString(),
      },
    }),
  })
  const payload = await response.json().catch(() => ({})) as {
    data?: { viewer?: { accounts?: Array<{ r2StorageAdaptiveGroups?: Array<{
      dimensions?: { bucketName?: string; datetime?: string }
      max?: { objectCount?: number; payloadSize?: number }
    }> }> } }
    errors?: Array<{ message?: string }>
  }
  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.[0]?.message || `R2 analytics query failed (${response.status})`)
  }
  const groups = payload.data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups ?? []
  const latestByAnalyticsName = new Map<string, BucketMetric>()
  for (const group of groups) {
    const bucket = group.dimensions?.bucketName
    const observedAt = group.dimensions?.datetime
    const objectCount = group.max?.objectCount
    const payloadSize = group.max?.payloadSize
    if (!bucket || !observedAt || latestByAnalyticsName.has(bucket)) continue
    if (typeof objectCount !== "number" || !Number.isFinite(objectCount)) continue
    if (typeof payloadSize !== "number" || !Number.isFinite(payloadSize)) continue
    latestByAnalyticsName.set(bucket, {
      bucket,
      objects: Math.max(0, Math.trunc(objectCount)),
      bytes: Math.max(0, Math.trunc(payloadSize)),
      observedAt,
    })
  }
  return buckets.flatMap((bucket) => {
    const analyticsName = bucket.jurisdiction === "default" ? bucket.name : `${bucket.jurisdiction}_${bucket.name}`
    const metric = latestByAnalyticsName.get(analyticsName)
    return metric ? [{ ...metric, bucket: bucket.name }] : []
  })
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

async function selectNextAccount(db: Client, syncIntervalMinutes: number) {
  const account = await db.query<AccountRow>(`
    select id,label,email,api_token,cloudflare_account_id,status,last_synced_at
    from drive_accounts
    where api_token<>''
      and (last_synced_at is null or last_synced_at < now() - ($1::text || ' minutes')::interval)
    order by last_synced_at asc nulls first, created_at asc limit 1
  `, [syncIntervalMinutes])
  return account.rows[0] ?? null
}

async function loadSyncProgress(db: Client) {
  const result = await db.query<{ account_id: string; bucket_names: unknown; bucket_offset: number }>(
    `select account_id, bucket_names, bucket_offset from drive_backend_orchestrator_progress where id=true limit 1`
  )
  const row = result.rows[0]
  if (!row || !Array.isArray(row.bucket_names)) return null
  return {
    accountId: row.account_id,
    buckets: row.bucket_names.flatMap((value): BucketInfo[] => {
      if (typeof value === "string" && value.length > 0) return [{ name: value, jurisdiction: "default" }]
      if (!value || typeof value !== "object") return []
      const bucket = value as { name?: unknown; jurisdiction?: unknown }
      return typeof bucket.name === "string" && bucket.name.length > 0
        ? [{ name: bucket.name, jurisdiction: typeof bucket.jurisdiction === "string" ? bucket.jurisdiction : "default" }]
        : []
    }),
    bucketOffset: Math.max(0, Math.trunc(Number(row.bucket_offset) || 0)),
  }
}

async function selectAccountById(db: Client, accountId: string) {
  const result = await db.query<AccountRow>(`
    select id,label,email,api_token,cloudflare_account_id,status,last_synced_at
    from drive_accounts where id=$1 and api_token<>'' limit 1
  `, [accountId])
  return result.rows[0] ?? null
}

async function saveSyncProgress(db: Client, input: { accountId: string; buckets: BucketInfo[]; bucketOffset: number }) {
  await db.query(`
    insert into drive_backend_orchestrator_progress (id,account_id,bucket_names,bucket_offset,started_at,updated_at)
    values (true,$1,$2::jsonb,$3,now(),now())
    on conflict (id) do update set
      account_id=excluded.account_id, bucket_names=excluded.bucket_names,
      bucket_offset=excluded.bucket_offset, updated_at=now()
  `, [input.accountId, JSON.stringify(input.buckets), input.bucketOffset])
}

async function clearSyncProgress(db: Client) {
  await db.query(`delete from drive_backend_orchestrator_progress where id=true`)
}

async function applyBucketMetrics(db: Client, account: AccountRow, metrics: BucketMetric[]) {
  if (metrics.length === 0) return
  await db.query(
    `
      with input as (
        select bucket, objects, bytes
        from jsonb_to_recordset($2::jsonb) as value(bucket text, objects bigint, bytes bigint)
      ), updated_stats as (
        update drive_bucket_stats stats set
          objects=input.objects, bytes=input.bytes, continuation_token=null,
          status='completed', error=null, updated_at=now()
        from input where stats.account_id=$1 and stats.bucket_name=input.bucket
        returning stats.bucket_name
      ), latest as (
        select input.*,
               history.objects previous_objects,
               history.bytes previous_bytes
        from input
        left join lateral (
          select objects, bytes from drive_bucket_stat_history
          where account_id=$1 and bucket_name=input.bucket
          order by changed_at desc, id desc limit 1
        ) history on true
      ), inserted as (
        insert into drive_bucket_stat_history (
          account_id, account_label, account_email, bucket_name,
          previous_objects, objects, object_delta, previous_bytes, bytes, byte_delta, change_type
        )
        select $1, $3, $4, bucket,
               previous_objects, objects, objects-coalesce(previous_objects,0),
               previous_bytes, bytes, bytes-coalesce(previous_bytes,0),
               case when previous_objects is null then 'created' else 'changed' end
        from latest
        where previous_objects is null or previous_objects is distinct from objects or previous_bytes is distinct from bytes
        returning account_id, account_label, account_email, bucket_name, objects, bytes, changed_at
      )
      insert into drive_analytics_bucket_snapshots
        (account_id,account_label,account_email,bucket_name,objects,bytes,status,source_updated_at,captured_at)
      select account_id,account_label,account_email,bucket_name,objects,bytes,'completed',changed_at,changed_at
      from inserted
      on conflict(account_id,bucket_name) do update set
        account_label=excluded.account_label, account_email=excluded.account_email,
        objects=excluded.objects, bytes=excluded.bytes, status=excluded.status,
        source_updated_at=excluded.source_updated_at, captured_at=excluded.captured_at
    `,
    [account.id, JSON.stringify(metrics), account.label, account.email]
  )
}

async function syncNextAccount(db: Client, config: RuntimeConfig) {
  let progress = await loadSyncProgress(db)
  let account = progress
    ? await selectAccountById(db, progress.accountId)
    : await selectNextAccount(db, config.syncIntervalMinutes)
  if (progress && !account) {
    await clearSyncProgress(db)
    progress = null
    account = await selectNextAccount(db, config.syncIntervalMinutes)
  }
  if (!account) return { status: "idle", message: "No account is due for synchronization" }
  try {
    if (!account.cloudflare_account_id) {
      const resolved = await resolveCloudflareAccount(account)
      account.cloudflare_account_id = resolved.id
      await db.query(`update drive_accounts set cloudflare_account_id=$2,cloudflare_account_name=$3,updated_at=now() where id=$1`, [account.id, resolved.id, resolved.name])
    }
    await db.query(`update drive_accounts set sync_status='syncing',sync_message='Backend Orchestrator metrics sync running',updated_at=now() where id=$1`, [account.id])
    const buckets = progress ? progress.buckets : await listBuckets(account)
    const bucketNames = buckets.map((bucket) => bucket.name)
    const bucketOffset = progress?.accountId === account.id ? Math.min(progress.bucketOffset, buckets.length) : 0
    if (!progress || progress.accountId !== account.id) {
      await reconcileBuckets(db, account, bucketNames)
      await saveSyncProgress(db, { accountId: account.id, buckets, bucketOffset: 0 })
    }
    if (buckets.length === 0) {
      await clearSyncProgress(db)
      await db.query(`update drive_accounts set total_buckets=0,total_objects=0,total_bytes=0,sync_status='ok',sync_message='No R2 buckets',last_synced_at=now(),updated_at=now() where id=$1`, [account.id])
      return { account: account.label, status: "completed", buckets: 0 }
    }
    const metrics = await getBucketMetrics(account, buckets)
    const batch = buckets.slice(bucketOffset, bucketOffset + BUCKET_BATCH_SIZE)
    const metricByBucket = new Map(metrics.map((metric) => [metric.bucket, metric]))
    for (const [index, bucket] of batch.entries()) {
      const metric = metricByBucket.get(bucket.name)
      if (metric) await applyBucketMetrics(db, account, [metric])
      await saveSyncProgress(db, { accountId: account.id, buckets, bucketOffset: bucketOffset + index + 1 })
    }
    const nextOffset = bucketOffset + batch.length
    if (nextOffset < buckets.length) {
      await saveSyncProgress(db, { accountId: account.id, buckets, bucketOffset: nextOffset })
      return { account: account.label, status: "in_progress", buckets: buckets.length, processedBuckets: nextOffset, remainingBuckets: buckets.length - nextOffset }
    }
    await clearSyncProgress(db)
    await db.query(`
      update drive_accounts a set
        total_buckets=(select count(*) from drive_bucket_stats s where s.account_id=a.id),
        total_objects=(select coalesce(sum(objects),0) from drive_bucket_stats s where s.account_id=a.id),
        total_bytes=(select coalesce(sum(bytes),0) from drive_bucket_stats s where s.account_id=a.id),
        sync_status='ok',sync_message=$2,last_synced_at=now(),updated_at=now()
      where a.id=$1
    `, [account.id, `R2 metrics synced for ${metrics.length} of ${buckets.length} buckets`])
    return {
      account: account.label,
      status: "completed",
      buckets: buckets.length,
      metrics: metrics.length,
      missingMetrics: buckets.length - metrics.length,
      latestObservedAt: metrics.reduce<string | null>((latest, metric) => !latest || metric.observedAt > latest ? metric.observedAt : latest, null),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.query(`update drive_accounts set sync_status='error',sync_message=$2,last_synced_at=now(),updated_at=now() where id=$1`, [account.id, message]).catch(() => undefined)
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
  if (response.status === 403) return { ok: false, disabled: true }
  if (!response.ok) throw new Error(`Panel reconciliation failed (${response.status})`)
  return response.json()
}

async function runCycle(env: Env, orchestratorUrl?: string) {
  const config = runtimeConfig(env)
  const db = dbClient(config.postgresUrl, config.disablePostgresSsl)
  await db.connect()
  let locked = false
  try {
    await ensureProgressSchema(db)
    const lock = await db.query<{ locked: boolean }>(`select pg_try_advisory_lock(hashtext('drive-backend-orchestrator')) locked`)
    locked = lock.rows[0]?.locked === true
    if (!locked) return { ok: true, skipped: "Another Backend Orchestrator cycle is active" }
    const panel = await reconcilePanel(env)
    if (panel && typeof panel === "object" && "disabled" in panel && panel.disabled === true) {
      return { ok: true, skipped: "Backend Orchestrator is disabled in the panel" }
    }
    await setState(db, { status: "running", orchestratorUrl })
    await db.query(`
      update drive_bucket_scans set status='failed',error='Superseded by R2 analytics metrics sync',completed_at=now(),updated_at=now()
      where kind='orchestrator' and status='running'
    `)
    const sync = await syncNextAccount(db, config)
    const maintenance = await runRetention(db, config)
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
        db = dbClient(config.postgresUrl, config.disablePostgresSsl)
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
        db = dbClient(config.postgresUrl, config.disablePostgresSsl)
        await db.connect()
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
