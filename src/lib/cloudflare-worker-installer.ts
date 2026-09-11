import { createHash, randomBytes, randomUUID } from "node:crypto"

import { queryDb, withDbAdvisoryLock, withDbTransaction } from "@/lib/db"
import { getBackendOrchestratorSettings } from "@/lib/backend-orchestrator-settings-store"
import { getMigrationOrchestratorSettings } from "@/lib/migration-orchestrator-settings-store"

export type HostedWorker = "backend" | "scanner" | "migration"
export type InstallMode = "single" | "separate"

type TokenMap = Record<HostedWorker, string>
type Account = { id: string; name: string }
type Artifact = { url: string; sha256: string; compatibilityDate: string; compatibilityFlags?: string[] }
type Manifest = { version: string; workers: Record<HostedWorker, Artifact> }
type WorkerState = { accountId?: string; accountName?: string; scriptName: string; url?: string; deployed?: boolean; verified?: boolean }
type InstallState = {
  id: string
  mode: InstallMode
  releaseVersion?: string
  status: "pending" | "running" | "ready" | "failed"
  step: string
  secrets: Record<HostedWorker, string>
  workers: Record<HostedWorker, WorkerState>
  error?: string
  updatedAt: string
}
type RuntimeSnapshot = {
  backend: { enabled: boolean; orchestratorUrl: string; sharedSecret: string; syncIntervalMinutes: number }
  migration: { enabled: boolean; migrationEnabled: boolean; fileScannerEnabled: boolean; orchestratorUrl: string; fileScannerUrl: string; sharedSecret: string; fileScannerSecret: string }
}
type HostingPreference = { mode: "automatic" | "manual"; manual?: RuntimeSnapshot }

const API = "https://api.cloudflare.com/client/v4"
const ORDER: HostedWorker[] = ["backend", "scanner", "migration"]

function panelUrl() {
  const configured = String(process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || process.env.NEXTAUTH_URL || "").trim()
  const vercel = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "").trim()
  const value = configured || (vercel ? `https://${vercel}` : "")
  return value.replace(/\/+$/, "")
}

function installationSuffix() {
  return createHash("sha256").update((panelUrl() || "drive").toLowerCase()).digest("hex").slice(0, 10)
}

function resourceNames() {
  const suffix = installationSuffix()
  return {
    scripts: { backend: `drive-backend-${suffix}`, scanner: `drive-file-scanner-${suffix}`, migration: `drive-migration-${suffix}` } satisfies Record<HostedWorker, string>,
    scannerQueue: `drive-file-scan-${suffix}`,
    scannerDlq: `drive-file-scan-dlq-${suffix}`,
    migrationQueue: `drive-github-dispatch-${suffix}`,
    migrationDlq: `drive-github-dispatch-dlq-${suffix}`,
  }
}

function jsonState(row: unknown): InstallState | null {
  if (!row || typeof row !== "object") return null
  return row as InstallState
}

async function ensureTable() {
  await queryDb(`create table if not exists drive_cloudflare_worker_installations (
    id uuid primary key, state jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  )`)
}

async function loadState(): Promise<InstallState | null> {
  await ensureTable()
  const result = await queryDb<{ state: unknown }>(`select state from drive_cloudflare_worker_installations order by updated_at desc limit 1`)
  return jsonState(result.rows[0]?.state)
}

async function saveState(state: InstallState) {
  state.updatedAt = new Date().toISOString()
  await queryDb(`insert into drive_cloudflare_worker_installations(id,state,updated_at) values($1,$2::jsonb,now())
    on conflict(id) do update set state=excluded.state,updated_at=now()`, [state.id, JSON.stringify(state)])
}

async function saveRuntimeConfiguration(state: InstallState, enabled: boolean) {
  const [backend, migration] = await Promise.all([getBackendOrchestratorSettings(), getMigrationOrchestratorSettings()])
  const backendValue = {
    enabled,
    orchestratorUrl: state.workers.backend.url || "",
    sharedSecret: state.secrets.backend,
    syncIntervalMinutes: backend.syncIntervalMinutes,
  }
  const migrationValue = {
    enabled,
    migrationEnabled: enabled,
    fileScannerEnabled: enabled,
    orchestratorUrl: state.workers.migration.url || "",
    fileScannerUrl: state.workers.scanner.url || "",
    sharedSecret: state.secrets.migration,
    fileScannerSecret: state.secrets.scanner,
  }
  await withDbTransaction(async (client) => {
    await client.query(`insert into drive_app_settings(key,value,updated_at) values('backend-orchestrator',$1::jsonb,now()) on conflict(key) do update set value=excluded.value,updated_at=now()`, [JSON.stringify(backendValue)])
    await client.query(`insert into drive_app_settings(key,value,updated_at) values('migration-orchestrator',$1::jsonb,now()) on conflict(key) do update set value=excluded.value,updated_at=now()`, [JSON.stringify(migrationValue)])
  })
}

async function currentRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  const [backend, migration] = await Promise.all([getBackendOrchestratorSettings(), getMigrationOrchestratorSettings()])
  return {
    backend: { enabled: backend.enabled, orchestratorUrl: backend.orchestratorUrl, sharedSecret: backend.sharedSecret, syncIntervalMinutes: backend.syncIntervalMinutes },
    migration: { enabled: migration.enabled, migrationEnabled: migration.migrationEnabled, fileScannerEnabled: migration.fileScannerEnabled, orchestratorUrl: migration.orchestratorUrl, fileScannerUrl: migration.fileScannerUrl, sharedSecret: migration.sharedSecret, fileScannerSecret: migration.fileScannerSecret },
  }
}

async function writeRuntimeSnapshot(snapshot: RuntimeSnapshot) {
  await withDbTransaction(async (client) => {
    await client.query(`insert into drive_app_settings(key,value,updated_at) values('backend-orchestrator',$1::jsonb,now()) on conflict(key) do update set value=excluded.value,updated_at=now()`, [JSON.stringify(snapshot.backend)])
    await client.query(`insert into drive_app_settings(key,value,updated_at) values('migration-orchestrator',$1::jsonb,now()) on conflict(key) do update set value=excluded.value,updated_at=now()`, [JSON.stringify(snapshot.migration)])
  })
}

export async function getCloudflareHostingPreference(): Promise<HostingPreference> {
  const result = await queryDb<{ value: unknown }>(`select value from drive_app_settings where key='cloudflare-worker-hosting' limit 1`)
  const value = result.rows[0]?.value
  if (!value || typeof value !== "object") return { mode: "manual" }
  const row = value as Partial<HostingPreference>
  return { mode: row.mode === "automatic" ? "automatic" : "manual", manual: row.manual }
}

export async function setCloudflareHostingMode(mode: "automatic" | "manual", refreshManual = false) {
  const current = await getCloudflareHostingPreference()
  let manual = current.manual
  if ((current.mode === "manual" && mode === "automatic") || (mode === "manual" && refreshManual)) manual = await currentRuntimeSnapshot()
  if (mode === "manual") {
    if (manual) await writeRuntimeSnapshot(manual)
  } else {
    const installation = await loadState()
    if (installation?.status === "ready") await saveRuntimeConfiguration(installation, true)
    else {
      const disabled = await currentRuntimeSnapshot()
      disabled.backend.enabled = false
      disabled.migration.enabled = false
      disabled.migration.migrationEnabled = false
      disabled.migration.fileScannerEnabled = false
      await writeRuntimeSnapshot(disabled)
    }
  }
  const preference: HostingPreference = { mode, manual }
  await queryDb(`insert into drive_app_settings(key,value,updated_at) values('cloudflare-worker-hosting',$1::jsonb,now()) on conflict(key) do update set value=excluded.value,updated_at=now()`, [JSON.stringify(preference)])
  return { mode }
}

function freshState(mode: InstallMode): InstallState {
  const names = resourceNames()
  return {
    id: randomUUID(), mode, status: "pending", step: "created",
    secrets: { backend: randomBytes(32).toString("base64url"), scanner: randomBytes(32).toString("base64url"), migration: randomBytes(32).toString("base64url") },
    workers: {
      backend: { scriptName: names.scripts.backend }, scanner: { scriptName: names.scripts.scanner }, migration: { scriptName: names.scripts.migration },
    },
    updatedAt: new Date().toISOString(),
  }
}

async function cf<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const isForm = typeof FormData !== "undefined" && init.body instanceof FormData
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body && !isForm ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(25_000),
  })
  const payload = await response.json().catch(() => ({})) as { success?: boolean; result?: T; errors?: Array<{ message?: string }> }
  if (!response.ok || payload.success === false) throw new Error(payload.errors?.[0]?.message || `Cloudflare request failed (${response.status})`)
  return payload.result as T
}

async function resolveAccount(token: string): Promise<Account> {
  const accounts = await cf<Account[]>(token, "/accounts?per_page=50")
  if (accounts.length !== 1) throw new Error(accounts.length ? "Token can access multiple accounts; create an account-scoped token" : "Token cannot access a Cloudflare account")
  return accounts[0]
}

async function getManifest(): Promise<Manifest> {
  const sourceRepository = String(process.env.GITHUB_WORKER_SOURCE_REPO || "iamnadith/Drive").trim()
  const defaultUrl = `https://github.com/${sourceRepository}/releases/latest/download/manifest.json`
  const url = String(process.env.CLOUDFLARE_WORKER_MANIFEST_URL || defaultUrl).trim()
  if (!/^https:\/\//i.test(url)) throw new Error("CLOUDFLARE_WORKER_MANIFEST_URL is not configured")
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Unable to fetch Worker release manifest (${response.status})`)
  const manifest = await response.json() as Manifest
  if (!manifest.version || !ORDER.every((worker) => manifest.workers?.[worker]?.url && /^[a-f0-9]{64}$/i.test(manifest.workers[worker].sha256))) throw new Error("Worker release manifest is invalid")
  return manifest
}

async function artifact(entry: Artifact): Promise<Uint8Array> {
  const response = await fetch(entry.url, { cache: "no-store", signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Unable to fetch Worker artifact (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (digest !== entry.sha256.toLowerCase()) throw new Error("Worker artifact checksum mismatch")
  return bytes
}

async function ensureQueue(token: string, accountId: string, name: string) {
  const queues = await cf<Array<{ queue_id: string; queue_name: string }>>(token, `/accounts/${accountId}/queues?per_page=100`)
  const existing = queues.find((queue) => queue.queue_name === name)
  return existing || cf<{ queue_id: string; queue_name: string }>(token, `/accounts/${accountId}/queues`, { method: "POST", body: JSON.stringify({ queue_name: name }) })
}

async function uploadWorker(input: { worker: HostedWorker; token: string; accountId: string; entry: Artifact; code: Uint8Array; state: InstallState }) {
  const { worker, token, accountId, entry, code, state } = input
  const publicPanelUrl = panelUrl()
  const postgresUrl = String(process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || "")
  if (!/^https:\/\//i.test(publicPanelUrl) || !postgresUrl) throw new Error("Panel URL or PostgreSQL URL is not configured")
  const postgresSsl = String(process.env.POSTGRES_SSL || "").trim().toLowerCase()
  const disablePostgresSsl = postgresSsl === "0" || postgresSsl === "false" || ["1", "true"].includes(String(process.env.DISABLE_POSTGRES_SSL || "").trim().toLowerCase())
  const bindings: Array<Record<string, unknown>> = [
    { type: "secret_text", name: "POSTGRES_URL", text: postgresUrl },
    { type: "secret_text", name: worker === "backend" ? "BACKEND_ORCHESTRATOR_SECRET" : worker === "scanner" ? "FILE_SCANNER_SECRET" : "MIGRATION_ORCHESTRATOR_SECRET", text: state.secrets[worker] },
    { type: "plain_text", name: "PANEL_URL", text: publicPanelUrl },
    { type: "plain_text", name: "DISABLE_POSTGRES_SSL", text: disablePostgresSsl ? "1" : "0" },
  ]
  const names = resourceNames()
  if (worker === "scanner") bindings.push({ type: "queue", name: "FILE_SCAN_QUEUE", queue_name: names.scannerQueue })
  if (worker === "migration") bindings.push({ type: "queue", name: "GITHUB_DISPATCH_QUEUE", queue_name: names.migrationQueue })
  const form = new FormData()
  form.set("metadata", JSON.stringify({ main_module: "index.js", compatibility_date: entry.compatibilityDate, compatibility_flags: entry.compatibilityFlags || ["nodejs_compat_v2"], bindings, observability: { enabled: true } }))
  const uploadBytes = code.buffer.slice(code.byteOffset, code.byteOffset + code.byteLength) as ArrayBuffer
  form.set("index.js", new Blob([uploadBytes], { type: "application/javascript+module" }), "index.js")
  const scriptName = state.workers[worker].scriptName
  await cf(token, `/accounts/${accountId}/workers/scripts/${scriptName}`, { method: "PUT", body: form, headers: {} })
  await cf(token, `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, { method: "POST", body: JSON.stringify({ enabled: true, previews_enabled: false }) })
}

async function setSchedule(token: string, accountId: string, scriptName: string) {
  await cf(token, `/accounts/${accountId}/workers/scripts/${scriptName}/schedules`, { method: "PUT", body: JSON.stringify([{ cron: "* * * * *" }]) })
}

async function configureConsumer(token: string, accountId: string, queueName: string, dlqName: string, scriptName: string, retryDelay: number) {
  const queue = await ensureQueue(token, accountId, queueName)
  await ensureQueue(token, accountId, dlqName)
  const consumers = await cf<Array<{ consumer_id: string; script_name?: string }>>(token, `/accounts/${accountId}/queues/${queue.queue_id}/consumers`)
  const body = JSON.stringify({ type: "worker", script_name: scriptName, dead_letter_queue: dlqName, settings: { batch_size: 1, max_wait_time_ms: 1000, max_retries: 20, retry_delay: retryDelay } })
  const existing = consumers.find((consumer) => consumer.script_name === scriptName)
  await cf(token, existing
    ? `/accounts/${accountId}/queues/${queue.queue_id}/consumers/${existing.consumer_id}`
    : `/accounts/${accountId}/queues/${queue.queue_id}/consumers`, { method: existing ? "PUT" : "POST", body })
}

async function workersDevUrl(token: string, accountId: string, scriptName: string) {
  const accountSubdomain = await cf<{ subdomain: string }>(token, `/accounts/${accountId}/workers/subdomain`)
  return `https://${scriptName}.${accountSubdomain.subdomain}.workers.dev`
}

async function verify(url: string, secret: string) {
  let lastError = "Worker did not become ready"
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const health = await fetch(`${url}/health`, { cache: "no-store", signal: AbortSignal.timeout(10_000) })
      if (!health.ok) throw new Error(`Health verification failed (${health.status})`)
      const status = await fetch(`${url}/status`, { cache: "no-store", headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15_000) })
      if (!status.ok) throw new Error(`Authenticated verification failed (${status.status})`)
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 750 * 2 ** attempt))
    }
  }
  throw new Error(lastError)
}

export async function getCloudflareInstallation() {
  const state = await loadState()
  if (!state) return null
  return { ...state, secrets: { backend: "", scanner: "", migration: "" } }
}

export async function installCloudflareWorkers(input: { mode: InstallMode; tokens: Partial<TokenMap>; restart?: boolean }) {
  return withDbAdvisoryLock("cloudflare-worker-install", "singleton", async () => {
    const shared = String(input.tokens.backend || "").trim()
    const tokens: TokenMap = input.mode === "single"
      ? { backend: shared, scanner: shared, migration: shared }
      : { backend: shared, scanner: String(input.tokens.scanner || "").trim(), migration: String(input.tokens.migration || "").trim() }
    if (ORDER.some((worker) => tokens[worker].length < 20)) throw new Error("Every selected Cloudflare token is required")
    const previous = await loadState()
    let state = input.restart ? null : previous
    if (!state || state.status === "ready" || state.mode !== input.mode) {
      state = freshState(input.mode)
      // Releases rotate code, not credentials. Preserving the already-generated
      // role secrets keeps the database and peer authentication synchronized
      // even if a redeploy is interrupted between Workers.
      if (previous?.status === "ready") state.secrets = previous.secrets
    }
    state.status = "running"; state.error = undefined; await saveState(state)
    await setCloudflareHostingMode("automatic")
    try {
      const names = resourceNames()
      const accounts = {} as Record<HostedWorker, Account>
      for (const worker of ORDER) {
        accounts[worker] = await resolveAccount(tokens[worker])
        if (state.workers[worker].accountId && state.workers[worker].accountId !== accounts[worker].id) {
          throw new Error(`${worker} token belongs to a different account than this resumable installation; choose Start fresh`)
        }
        state.workers[worker].accountId = accounts[worker].id
        state.workers[worker].accountName = accounts[worker].name
      }
      state.step = "accounts_validated"; await saveState(state)
      const manifest = await getManifest(); state.releaseVersion = manifest.version
      await saveState(state)
      await ensureQueue(tokens.scanner, accounts.scanner.id, names.scannerQueue)
      await ensureQueue(tokens.scanner, accounts.scanner.id, names.scannerDlq)
      await ensureQueue(tokens.migration, accounts.migration.id, names.migrationQueue)
      await ensureQueue(tokens.migration, accounts.migration.id, names.migrationDlq)
      state.step = "queues_ready"; await saveState(state)
      for (const worker of ORDER) {
        if (!state.workers[worker].deployed) {
          await uploadWorker({ worker, token: tokens[worker], accountId: accounts[worker].id, entry: manifest.workers[worker], code: await artifact(manifest.workers[worker]), state })
          if (worker === "scanner") await configureConsumer(tokens.scanner, accounts.scanner.id, names.scannerQueue, names.scannerDlq, state.workers.scanner.scriptName, 15)
          if (worker === "migration") await configureConsumer(tokens.migration, accounts.migration.id, names.migrationQueue, names.migrationDlq, state.workers.migration.scriptName, 30)
          state.workers[worker].url = await workersDevUrl(tokens[worker], accounts[worker].id, state.workers[worker].scriptName)
          state.workers[worker].deployed = true; state.step = `${worker}_deployed`; await saveState(state)
        }
      }
      await saveRuntimeConfiguration(state, false)
      state.step = "configuration_saved"; await saveState(state)
      for (const worker of ORDER) {
        await verify(state.workers[worker].url!, state.secrets[worker]); state.workers[worker].verified = true; await saveState(state)
      }
      for (const worker of ORDER) await setSchedule(tokens[worker], accounts[worker].id, state.workers[worker].scriptName)
      state.step = "schedules_ready"; await saveState(state)
      await saveRuntimeConfiguration(state, true)
      await queryDb(`insert into drive_app_settings(key,value,updated_at) values('cloudflare-worker-hosting',$1::jsonb,now()) on conflict(key) do update set value=jsonb_set(excluded.value,'{manual}',coalesce(drive_app_settings.value->'manual','null'::jsonb)),updated_at=now()`, [JSON.stringify({ mode: "automatic" })])
      state.status = "ready"; state.step = "enabled"; await saveState(state)
      return getCloudflareInstallation()
    } catch (error) {
      state.status = "failed"; state.error = error instanceof Error ? error.message : "Installation failed"; await saveState(state); throw error
    }
  })
}
