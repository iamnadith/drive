import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const panelUrl = String(process.env.PANEL_URL || "").trim().replace(/\/$/, "")
const sharedSecret = String(process.env.PANEL_SHARED_SECRET || "").trim()
const configuredOrchestratorUrl = String(process.env.ORCHESTRATOR_URL || "").trim().replace(/\/$/, "")
if (!panelUrl || !sharedSecret) {
  throw new Error("PANEL_URL and PANEL_SHARED_SECRET are required build variables")
}
if (!/^https:\/\//i.test(panelUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(panelUrl)) {
  throw new Error("PANEL_URL must use HTTPS")
}
if (sharedSecret.length < 24) throw new Error("PANEL_SHARED_SECRET must contain at least 24 characters")

function workerDatabaseUrl(value) {
  const url = new URL(String(value).trim())
  if (url.hostname.endsWith(".pooler.supabase.com") && url.port === "6543") url.port = "5432"
  return url.toString()
}

const response = await fetch(`${panelUrl}/api/internal/backend-orchestrator/config`, {
  headers: { Authorization: `Bearer ${sharedSecret}` },
})
const config = await response.json().catch(() => ({}))
if (!response.ok) {
  throw new Error(config?.error || `Unable to fetch Backend Orchestrator build configuration (${response.status})`)
}
if (![1, 2].includes(config?.version) || typeof config?.postgresUrl !== "string" || !config.postgresUrl.trim()) {
  throw new Error("Panel returned an invalid Backend Orchestrator build configuration")
}

const orchestratorUrl = configuredOrchestratorUrl || String(config?.orchestratorUrl || "").trim().replace(/\/$/, "")
if (!orchestratorUrl) throw new Error("Backend Orchestrator URL is not configured in the panel")
if (!/^https:\/\//i.test(orchestratorUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(orchestratorUrl)) {
  throw new Error("ORCHESTRATOR_URL must use HTTPS")
}

const deployedBindings = {
  PANEL_URL: panelUrl,
  PANEL_SHARED_SECRET: sharedSecret,
  ORCHESTRATOR_URL: orchestratorUrl,
  POSTGRES_URL: workerDatabaseUrl(config.postgresUrl),
  SYNC_INTERVAL_MINUTES: String(config.syncIntervalMinutes ?? 1),
  API_EVENTS_RETENTION_DAYS: String(config.retention?.apiEventsDays ?? 7),
  OBJECT_CHANGES_RETENTION_DAYS: String(config.retention?.objectChangesDays ?? 7),
  SCAN_DETAILS_RETENTION_DAYS: String(config.retention?.scanDetailsDays ?? 7),
  DISABLE_POSTGRES_SSL: config.disablePostgresSsl === true ? "1" : "0",
}

const tempDirectory = mkdtempSync(join(tmpdir(), "drive-backend-orchestrator-secrets-"))
const secretsPath = join(tempDirectory, "secrets.json")
try {
  writeFileSync(secretsPath, JSON.stringify(deployedBindings), { mode: 0o600 })
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", "deploy", "--secrets-file", secretsPath],
    { stdio: "inherit", shell: false }
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
} finally {
  rmSync(tempDirectory, { recursive: true, force: true })
}
