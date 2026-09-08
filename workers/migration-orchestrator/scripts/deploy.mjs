import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const panelUrl = String(process.env.PANEL_URL || "").trim().replace(/\/+$/, "")
const sharedSecret = String(process.env.MIGRATION_ORCHESTRATOR_SECRET || process.env.PANEL_SHARED_SECRET || "").trim()
if (!panelUrl || sharedSecret.length < 24) throw new Error("PANEL_URL and MIGRATION_ORCHESTRATOR_SECRET (at least 24 characters) are required build variables")
const response = await fetch(`${panelUrl}/api/internal/migration-orchestrator/config`, { headers: { Authorization: `Bearer ${sharedSecret}` } })
const config = await response.json().catch(() => ({}))
if (!response.ok || config?.version !== 1 || !config?.postgresUrl) throw new Error(config?.error || `Invalid Migration Orchestrator build configuration (${response.status})`)
const url = new URL(String(config.postgresUrl)); if (url.hostname.endsWith(".pooler.supabase.com") && url.port === "6543") url.port = "5432"
const directory = mkdtempSync(join(tmpdir(), "drive-migration-orchestrator-")); const secrets = join(directory, "secrets.json")
try {
  writeFileSync(secrets, JSON.stringify({ POSTGRES_URL: url.toString(), MIGRATION_ORCHESTRATOR_SECRET: sharedSecret, PANEL_URL: panelUrl }), { mode: 0o600 })
  const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "deploy", "--secrets-file", secrets], { stdio: "inherit", shell: false })
  if (result.status !== 0) process.exit(result.status ?? 1)
} finally { rmSync(directory, { recursive: true, force: true }) }
