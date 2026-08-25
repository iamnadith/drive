import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const panelUrl = String(process.env.PANEL_URL || "").trim().replace(/\/$/, "")
const sharedSecret = String(process.env.PANEL_SHARED_SECRET || "").trim()
if (!panelUrl || !sharedSecret) {
  throw new Error("PANEL_URL and PANEL_SHARED_SECRET build variables are required")
}
if (sharedSecret.length < 24) throw new Error("PANEL_SHARED_SECRET must contain at least 24 characters")

const tempDirectory = mkdtempSync(join(tmpdir(), "drive-backend-orchestrator-secrets-"))
const secretsPath = join(tempDirectory, "secrets.json")
try {
  writeFileSync(secretsPath, JSON.stringify({ PANEL_SHARED_SECRET: sharedSecret }), { mode: 0o600 })
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", "deploy", "--var", `PANEL_URL:${panelUrl}`, "--secrets-file", secretsPath],
    { stdio: "inherit", shell: false }
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
} finally {
  rmSync(tempDirectory, { recursive: true, force: true })
}
