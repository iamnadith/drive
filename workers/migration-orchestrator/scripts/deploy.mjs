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
const url = new URL(String(config.postgresUrl))
const directory = mkdtempSync(join(tmpdir(), "drive-migration-orchestrator-")); const secrets = join(directory, "secrets.json")
function ensureQueue(wrangler, name) {
  const created = spawnSync(wrangler, ["wrangler", "queues", "create", name], { encoding: "utf8", shell: false })
  const output = `${created.stdout || ""}\n${created.stderr || ""}`
  if (created.status === 0 || /already exists|already been taken|code.?10020/i.test(output)) return
  throw new Error(output.trim() || `Unable to create Cloudflare Queue ${name}`)
}
function deployWithRetry(wrangler, args) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync(wrangler, args, { encoding: "utf8", shell: false })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.status === 0) return
    const output = `${result.stdout || ""}\n${result.stderr || ""}`
    const transient = /503|service unavailable|connection termination|connection reset|malformed response/i.test(output)
    if (!transient || attempt === 3) process.exit(result.status ?? 1)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 3_000)
  }
}
try {
  const wrangler = process.platform === "win32" ? "npx.cmd" : "npx"
  const auth = spawnSync(wrangler, ["wrangler", "whoami"], { stdio: "inherit", shell: false })
  if (auth.status !== 0) process.exit(auth.status ?? 1)
  for (const name of ["drive-github-dispatch", "drive-github-dispatch-dlq"]) {
    ensureQueue(wrangler, name)
  }
  writeFileSync(secrets, JSON.stringify({ POSTGRES_URL: url.toString(), MIGRATION_ORCHESTRATOR_SECRET: sharedSecret }), { mode: 0o600 })
  deployWithRetry(wrangler, ["wrangler", "deploy", "--secrets-file", secrets, "--keep-vars", "--var", `PANEL_URL:${panelUrl}`, "--var", `DISABLE_POSTGRES_SSL:${config.disablePostgresSsl === true ? "1" : "0"}`])
} finally { rmSync(directory, { recursive: true, force: true }) }
