import { Client } from "pg"

type Env = { POSTGRES_URL?: string; FILE_SCANNER_SECRET?: string; PANEL_URL?: string; DISABLE_POSTGRES_SSL?: string }
type Row = Record<string, any>
const BUILD = 1
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
    const expected = String(env.FILE_SCANNER_SECRET || "")
    const stored = String((await db.query(`select value->>'fileScannerSecret' secret from drive_app_settings where key='migration-orchestrator' limit 1`)).rows[0]?.secret || "")
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
    create table if not exists drive_file_scanner_state (
      id boolean primary key default true check(id),status text not null default 'idle',last_started_at timestamptz,last_completed_at timestamptz,
      last_error text,last_result jsonb not null default '{}'::jsonb,cycle_count bigint not null default 0,updated_at timestamptz not null default now()
    );
    create index if not exists drive_migration_verification_state_queue_idx on drive_migration_verification_state(status,updated_at);
  `)
}
function pageSize(_env: Env) { return 1000 }
function encodePath(value: string) { return encodeURIComponent(value) }

async function listObjects(env: Env, account: Row, bucket: string, cursor: string | null, jurisdiction: string | null) {
  if (!account.cloudflare_account_id || !account.api_token) throw new Error("R2 account ID or API token is missing")
  const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account.cloudflare_account_id)}/r2/buckets/${encodePath(bucket)}/objects`)
  url.searchParams.set("per_page", String(pageSize(env)))
  if (cursor) url.searchParams.set("cursor", cursor)
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${account.api_token}`, Accept: "application/json" }
    if (jurisdiction && jurisdiction !== "default") headers["cf-r2-jurisdiction"] = jurisdiction
    const response = await fetch(url, { headers, signal: controller.signal })
    const payload = await response.json().catch(() => ({})) as Row
    if (!response.ok || payload.success === false) throw new Error(payload.errors?.[0]?.message || `R2 list returned HTTP ${response.status}`)
    const result = payload.result || payload
    const objects = Array.isArray(result.objects) ? result.objects.map((object: Row) => ({
      key: String(object.key || ""), size: Math.max(0, Number(object.size) || 0), etag: object.etag ? String(object.etag) : null,
      last_modified: object.last_modified || object.uploaded || null, is_dir_marker: String(object.key || "").endsWith("/") && Number(object.size || 0) === 0,
    })).filter((object: Row) => object.key) : []
    return { objects, truncated: result.truncated === true, cursor: typeof result.cursor === "string" && result.cursor ? result.cursor : null }
  } finally { clearTimeout(timeout) }
}

async function claim(db: Client, owner: string): Promise<Row | null> {
  const result = await db.query(`
    with candidate as (
      select v.migration_item_id,i.source_bucket,i.target_bucket,i.source_jurisdiction,m.source_account_id,m.target_account_id,
        jsonb_build_object('cloudflare_account_id',sa.cloudflare_account_id,'api_token',sa.api_token) source_account,
        jsonb_build_object('cloudflare_account_id',ta.cloudflare_account_id,'api_token',ta.api_token) target_account
      from drive_migration_verification_state v join drive_migrations m on m.id=v.migration_id
        join drive_migration_items i on i.id=v.migration_item_id
        join drive_accounts sa on sa.id=m.source_account_id join drive_accounts ta on ta.id=m.target_account_id
      where m.status='verifying' and m.options->>'executionMode'='migration_workers'
        and v.status in('pending','running') and (v.lease_expires_at is null or v.lease_expires_at<now())
      order by v.updated_at for update of v skip locked limit 1
    )
    update drive_migration_verification_state v set status='running',lease_owner=$1,lease_expires_at=now()+interval '90 seconds',
      attempt_count=case when v.attempt_generation<>v.generation then 0 else v.attempt_count end,
      attempt_generation=v.generation,last_error=case when v.attempt_generation<>v.generation then null else v.last_error end,updated_at=now()
    from candidate c where v.migration_item_id=c.migration_item_id
    returning v.*,c.source_bucket,c.target_bucket,c.source_jurisdiction,c.source_account_id,c.target_account_id,c.source_account,c.target_account
  `, [owner])
  return result.rows[0] || null
}
async function claimGenericScan(db: Client, owner: string): Promise<Row | null> {
  const result = await db.query(`
    with candidate as (
      select s.id,s.account_id,s.bucket_name,s.prefix,s.cursor,a.cloudflare_account_id,a.api_token,coalesce(bs.jurisdiction,'default') jurisdiction
      from drive_bucket_scans s join drive_accounts a on a.id=s.account_id
      left join drive_bucket_settings_snapshots bs on bs.account_id=s.account_id and bs.bucket_name=s.bucket_name
      where s.migration_item_id is null and s.status in('pending','running')
        and (s.lease_expires_at is null or s.lease_expires_at<now())
      order by s.updated_at for update of s skip locked limit 1
    )
    update drive_bucket_scans s set status='running',lease_owner=$1,lease_expires_at=now()+interval '90 seconds',started_at=coalesce(started_at,now()),updated_at=now()
    from candidate c where s.id=c.id
    returning s.*,c.cloudflare_account_id,c.api_token
  `, [owner])
  return result.rows[0] || null
}
async function ensureScan(db: Client, task: Row, phase: "source" | "destination") {
  const column = phase === "source" ? "source_scan_id" : "destination_scan_id"
  if (task[column]) return task[column]
  const id = crypto.randomUUID()
  const accountId = phase === "source" ? task.source_account_id : task.target_account_id
  const bucket = phase === "source" ? task.source_bucket : task.target_bucket
  const attached = await db.query(`
    with eligible as (
      select migration_item_id from drive_migration_verification_state
      where migration_item_id=$6 and generation=$7 and lease_owner=$8 for update
    ), created as (
      insert into drive_bucket_scans(id,account_id,bucket_name,kind,migration_id,migration_item_id,status,started_at,updated_at)
      select $1,$2,$3,$4,$5,$6,'running',now(),now() from eligible returning id
    ), attached as (
      update drive_migration_verification_state v set ${column}=c.id,updated_at=now()
      from created c where v.migration_item_id=$6 and v.generation=$7 and v.lease_owner=$8 returning c.id
    ) select id from attached
  `, [id, accountId, bucket, phase === "source" ? "source" : "dest", task.migration_id, task.migration_item_id, task.generation, task.lease_owner])
  if (!attached.rowCount) throw new Error("File Scanner task lease was lost")
  return attached.rows[0].id
}
async function storePage(db: Client, scanId: string, objects: Row[]) {
  if (!objects.length) return
  await db.query(`
    insert into drive_bucket_scan_objects(scan_id,key,size,is_dir_marker,etag,last_modified)
    select $1,x.key,x.size,x.is_dir_marker,x.etag,x.last_modified from jsonb_to_recordset($2::jsonb)
      as x(key text,size bigint,is_dir_marker boolean,etag text,last_modified timestamptz)
    on conflict(scan_id,key) do update set size=excluded.size,is_dir_marker=excluded.is_dir_marker,etag=excluded.etag,last_modified=excluded.last_modified
  `, [scanId, JSON.stringify(objects)])
}
async function compare(db: Client, task: Row) {
  await db.query("begin")
  try {
    const locked = await db.query(`
      with guard as (
        select migration_item_id from drive_migration_verification_state
        where migration_item_id=$1 and generation=$2 and lease_owner=$3 for update
      ), deleted as (
        delete from drive_bucket_verify_diffs d using guard g where d.migration_item_id=g.migration_item_id returning d.id
      ) select exists(select 1 from guard) acquired
    `, [task.migration_item_id, task.generation, task.lease_owner])
    if (locked.rows[0]?.acquired !== true) throw new Error("File Scanner task lease was lost")
    const completed = await db.query(`
      with source_diffs as (
        insert into drive_bucket_verify_diffs(id,migration_item_id,source_scan_id,dest_scan_id,kind,key,source_size,dest_size)
        select gen_random_uuid(),$1,$2,$3,case when d.key is null then 'missing' else 'size_mismatch' end,s.key,s.size,d.size
        from drive_bucket_scan_objects s left join drive_bucket_scan_objects d on d.scan_id=$3 and d.key=s.key
        where s.scan_id=$2 and (
          d.key is null or d.size<>s.size or
          (trim(both '"' from coalesce(s.etag,'')) ~ '^[0-9a-fA-F]{32}$' and trim(both '"' from coalesce(d.etag,'')) ~ '^[0-9a-fA-F]{32}$' and trim(both '"' from s.etag)<>trim(both '"' from d.etag))
        ) returning kind
      ), extra_diffs as (
        insert into drive_bucket_verify_diffs(id,migration_item_id,source_scan_id,dest_scan_id,kind,key,source_size,dest_size)
        select gen_random_uuid(),$1,$2,$3,'extra',d.key,null,d.size from drive_bucket_scan_objects d
        left join drive_bucket_scan_objects s on s.scan_id=$2 and s.key=d.key where d.scan_id=$3 and s.key is null
        returning kind
      ), counts as (
        select count(*) filter(where kind='missing')::int missing,
          count(*) filter(where kind='size_mismatch')::int mismatched,
          count(*) filter(where kind='extra')::int extra
        from (select kind from source_diffs union all select kind from extra_diffs) all_diffs
      ), state_done as (
        update drive_migration_verification_state v set status='completed',phase='complete',missing_objects=c.missing,
          mismatched_objects=c.mismatched,extra_objects=c.extra,lease_owner=null,lease_expires_at=null,completed_at=now(),updated_at=now()
        from counts c where v.migration_item_id=$1 and v.generation=$4 and v.lease_owner=$5
        returning c.missing,c.mismatched,c.extra
      ), item_done as (
        update drive_migration_items i set source_objects=$6,source_bytes=$7,last_progress_at=now(),updated_at=now(),
          progress=jsonb_set(jsonb_set(coalesce(i.progress,'{}'::jsonb),'{fileVerification}',jsonb_build_object(
            'status','completed','missing',s.missing,'mismatched',s.mismatched,'extra',s.extra,'generation',$4::int,'completedAt',now()
          )), '{stage}','"file_verification_completed"'::jsonb)
        from state_done s where i.id=$1 returning i.id
      ) select missing,mismatched,extra from state_done
    `, [task.migration_item_id, task.source_scan_id, task.destination_scan_id, task.generation, task.lease_owner, task.source_objects, task.source_bytes])
    if (!completed.rowCount) throw new Error("File Scanner task lease was lost")
    await db.query("commit")
    const value = completed.rows[0]
    return { missing: Number(value.missing), mismatched: Number(value.mismatched), extra: Number(value.extra) }
  } catch (error) { await db.query("rollback"); throw error }
}
async function wakeMigrationOrchestrator(db: Client) {
  const result = await db.query(`select value from drive_app_settings where key='migration-orchestrator' limit 1`)
  const settings = result.rows[0]?.value || {}
  if (!settings.orchestratorUrl || !settings.sharedSecret) return "not_configured"
  try {
    const response = await fetch(`${String(settings.orchestratorUrl).replace(/\/+$/, "")}/run`, { method: "POST", headers: { Authorization: `Bearer ${settings.sharedSecret}` }, signal: AbortSignal.timeout(8_000) })
    return response.ok ? "signaled" : `http_${response.status}`
  } catch { return "deferred_to_cron" }
}
async function compareAndWake(db: Client, task: Row) {
  const result = await compare(db, task)
  return { ...result, migrationOrchestrator: await wakeMigrationOrchestrator(db) }
}
async function processTask(db: Client, env: Env, task: Row) {
  if (task.phase === "compare") return { itemId: task.migration_item_id, phase: "compare", ...(await compareAndWake(db, task)) }
  const phase: "source" | "destination" = task.phase === "destination" ? "destination" : "source"
  const scanId = await ensureScan(db, task, phase)
  task[phase === "source" ? "source_scan_id" : "destination_scan_id"] = scanId
  const account = phase === "source" ? task.source_account : task.target_account
  const bucket = phase === "source" ? task.source_bucket : task.target_bucket
  const cursor = phase === "source" ? task.source_cursor : task.destination_cursor
  const page = await listObjects(env, account, bucket, cursor, task.source_jurisdiction || null)
  await storePage(db, scanId, page.objects)
  const objects = page.objects.length; const bytes = page.objects.reduce((sum: number, object: Row) => sum + object.size, 0)
  const cursorColumn = phase === "source" ? "source_cursor" : "destination_cursor"
  const objectsColumn = phase === "source" ? "source_objects" : "destination_objects"
  const bytesColumn = phase === "source" ? "source_bytes" : "destination_bytes"
  if (page.truncated) {
    if (!page.cursor || page.cursor === cursor) throw new Error("R2 returned a truncated page without a forward cursor")
    await db.query(`update drive_bucket_scans set objects=(select count(*) from drive_bucket_scan_objects where scan_id=$1),bytes=(select coalesce(sum(size),0) from drive_bucket_scan_objects where scan_id=$1),last_key=$2,updated_at=now() where id=$1`, [scanId, page.objects.at(-1)?.key || null])
    const advanced = await db.query(`update drive_migration_verification_state set ${cursorColumn}=$2,${objectsColumn}=(select count(*) from drive_bucket_scan_objects where scan_id=$3),${bytesColumn}=(select coalesce(sum(size),0) from drive_bucket_scan_objects where scan_id=$3),status='pending',lease_owner=null,lease_expires_at=null,updated_at=now() where migration_item_id=$1 and generation=$4 and lease_owner=$5`, [task.migration_item_id, page.cursor, scanId, task.generation, task.lease_owner])
    if (!advanced.rowCount) throw new Error("File Scanner task lease was lost")
    return { itemId: task.migration_item_id, phase, pageObjects: objects, continued: true }
  }
  await db.query(`update drive_bucket_scans set status='completed',objects=(select count(*) from drive_bucket_scan_objects where scan_id=$1),bytes=(select coalesce(sum(size),0) from drive_bucket_scan_objects where scan_id=$1),last_key=$2,completed_at=now(),updated_at=now() where id=$1`, [scanId, page.objects.at(-1)?.key || null])
  const advanced = await db.query(`update drive_migration_verification_state set ${cursorColumn}=null,${objectsColumn}=(select count(*) from drive_bucket_scan_objects where scan_id=$2),${bytesColumn}=(select coalesce(sum(size),0) from drive_bucket_scan_objects where scan_id=$2),phase=$3,status='pending',lease_owner=null,lease_expires_at=null,updated_at=now() where migration_item_id=$1 and generation=$4 and lease_owner=$5`, [task.migration_item_id, scanId, phase === "source" ? "destination" : "compare", task.generation, task.lease_owner])
  if (!advanced.rowCount) throw new Error("File Scanner task lease was lost")
  if (phase === "source") return { itemId: task.migration_item_id, phase, pageObjects: objects, continued: false }
  const refreshed = (await db.query(`select * from drive_migration_verification_state where migration_item_id=$1`, [task.migration_item_id])).rows[0]
  return { itemId: task.migration_item_id, phase: "compare", ...(await compareAndWake(db, { ...task, ...refreshed })) }
}
async function processGenericScan(db: Client, env: Env, task: Row) {
  const account = { cloudflare_account_id: task.cloudflare_account_id, api_token: task.api_token }
  const page = await listObjects(env, account, task.bucket_name, task.cursor || null, null)
  await storePage(db, task.id, page.objects)
  if (page.truncated && (!page.cursor || page.cursor === task.cursor)) throw new Error("R2 returned a truncated page without a forward cursor")
  const updated = await db.query(`
    update drive_bucket_scans set cursor=$2,status=$3,objects=(select count(*) from drive_bucket_scan_objects where scan_id=$1),
      bytes=(select coalesce(sum(size),0) from drive_bucket_scan_objects where scan_id=$1),last_key=$4,
      lease_owner=null,lease_expires_at=null,completed_at=case when $3='completed' then now() else completed_at end,updated_at=now()
    where id=$1 and lease_owner=$5 returning objects,bytes,status
  `, [task.id, page.truncated ? page.cursor : null, page.truncated ? "pending" : "completed", page.objects.at(-1)?.key || task.last_key || null, task.lease_owner])
  if (!updated.rowCount) throw new Error("File Scanner generic scan lease was lost")
  return { scanId: task.id, phase: "inventory", pageObjects: page.objects.length, continued: page.truncated, ...updated.rows[0] }
}
async function finishState(db: Client, owner: string, result: Row, error?: string) {
  await db.query(`update drive_file_scanner_state set status=$1,lease_owner=null,last_completed_at=now(),last_error=$2,last_result=$3::jsonb,cycle_count=cycle_count+1,updated_at=now() where id=true and lease_owner=$4`, [error ? "error" : "idle", error || null, JSON.stringify(result), owner])
}
async function cycle(env: Env) {
  return database(env, async (db) => {
    const owner = crypto.randomUUID()
    const lease = await db.query(`
      insert into drive_file_scanner_state(id,status,lease_owner,last_started_at,last_error,updated_at) values(true,'running',$1,now(),null,now())
      on conflict(id) do update set status='running',lease_owner=$1,last_started_at=now(),last_error=null,updated_at=now()
        where drive_file_scanner_state.status<>'running' or drive_file_scanner_state.last_started_at<now()-interval '150 seconds'
      returning id
    `, [owner])
    if (!lease.rowCount) return { ok: true, skipped: "cycle_already_running" }
    let task: Row | null = null
    let genericTask: Row | null = null
    try {
      const setting = await db.query(`select value from drive_app_settings where key='migration-orchestrator' limit 1`)
      if (setting.rows[0]?.value?.fileScannerEnabled !== true && setting.rows[0]?.value?.enabled !== true) { const result = { ok: true, skipped: "disabled" }; await finishState(db, owner, result); return result }
      task = await claim(db, owner)
      if (!task) genericTask = await claimGenericScan(db, owner)
      const result = task
        ? { ok: true, ...(await processTask(db, env, task)) }
        : genericTask
          ? { ok: true, ...(await processGenericScan(db, env, genericTask)) }
          : { ok: true, idle: true }
      await finishState(db, owner, result); return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (task) await db.query(`update drive_migration_verification_state set status=case when attempt_count>=4 then 'failed' else 'pending' end,attempt_count=attempt_count+1,last_error=$2,lease_owner=null,lease_expires_at=null,updated_at=now() where migration_item_id=$1 and generation=$3 and lease_owner=$4`, [task.migration_item_id, message, task.generation, owner]).catch(() => undefined)
      if (genericTask) await db.query(`update drive_bucket_scans set status=case when attempt_count>=4 then 'failed' else 'pending' end,attempt_count=attempt_count+1,error=$2,lease_owner=null,lease_expires_at=null,updated_at=now() where id=$1 and lease_owner=$3`, [genericTask.id, message, owner]).catch(() => undefined)
      await finishState(db, owner, { ok: false, error: message }, message).catch(() => undefined); throw error
    }
  })
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "file-scanner", build: BUILD })
    }
    if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401)
    if (url.pathname === "/status" && request.method === "GET") return json(await database(env, async (db) => { const state = await db.query(`select * from drive_file_scanner_state where id=true`); const queue = await db.query(`select status,count(*)::int count from drive_migration_verification_state group by status`); return { ok: true, service: "file-scanner", build: BUILD, state: state.rows[0] || null, queue: queue.rows } }))
    if (url.pathname === "/run" && request.method === "POST") { try { return json(await cycle(env)) } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 503) } }
    return json({ error: "Not found" }, 404)
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) { ctx.waitUntil(cycle(env).then(() => undefined).catch((error) => console.error(error))) },
}
