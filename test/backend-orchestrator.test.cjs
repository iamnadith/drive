/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

test("backend orchestrator uses the authenticated panel configuration handshake", () => {
  const orchestrator = read("workers/backend-orchestrator/src/index.ts")
  const deploy = read("workers/backend-orchestrator/scripts/deploy.mjs")
  const configRoute = read("src/app/api/internal/backend-orchestrator/config/route.ts")
  const settings = read("src/lib/backend-orchestrator-settings-store.ts")
  const settingsRoute = read("src/app/api/settings/backend-orchestrator/route.ts")
  const settingsPage = read("src/app/dashboard/settings/page.tsx")

  assert.match(orchestrator, /PANEL_URL: string/)
  assert.match(orchestrator, /PANEL_SHARED_SECRET: string/)
  assert.match(orchestrator, /POSTGRES_URL: string/)
  assert.match(orchestrator, /POSTGRES_URL was not injected during deployment/)
  assert.doesNotMatch(orchestrator, /\/api\/internal\/backend-orchestrator\/config/)
  assert.match(deploy, /\/api\/internal\/backend-orchestrator\/config/)
  assert.match(deploy, /POSTGRES_URL: config\.postgresUrl\.trim\(\)/)
  assert.match(deploy, /"wrangler", "deploy", "--secrets-file"/)
  assert.doesNotMatch(deploy, /process\.env\.POSTGRES/)
  assert.match(configRoute, /authenticateBackendOrchestrator/)
  assert.match(configRoute, /POSTGRES_URL_NON_POOLING/)
  assert.match(settings, /secretConfigured:/)
  assert.doesNotMatch(settings, /sharedSecret: settings\.sharedSecret/)
  assert.match(settingsRoute, /export async function PATCH/)
  assert.match(settingsRoute, /body\.action === "test"/)
  assert.match(settingsRoute, /enabled: false/)
  assert.match(settingsPage, /Secret saved/)
  assert.match(settingsPage, /Test connection/)
})

test("backend orchestrator scans bounded resumable pages and preserves change-only totals", () => {
  const orchestrator = read("workers/backend-orchestrator/src/index.ts")

  assert.match(orchestrator, /while \(pages < pagesPerRun\)/)
  assert.match(orchestrator, /ContinuationToken: token/)
  assert.match(orchestrator, /last_key=\$4/)
  assert.match(orchestrator, /latest\.objects is distinct from \$3/)
  assert.match(orchestrator, /latest\.bytes is distinct from \$4/)
  assert.match(orchestrator, /objects: 0, bytes: 0, deleted: true/)
  assert.match(orchestrator, /No account is due for synchronization/)
})

test("worker packages and GitHub workflow use their permanent names", () => {
  const rootPackage = read("package.json")
  const migrationPackage = read("workers/migration-worker/package.json")
  const workflow = read(".github/workflows/migration-worker.yml")
  const wrangler = read("workers/backend-orchestrator/wrangler.jsonc")

  assert.match(rootPackage, /migration-worker:run/)
  assert.match(migrationPackage, /drive-migration-worker/)
  assert.match(workflow, /name: Migration Worker/)
  assert.match(workflow, /working-directory: workers\/migration-worker/)
  assert.match(wrangler, /"name": "backend-orchestrator"/)
  assert.match(wrangler, /"crons": \["\* \* \* \* \*"\]/)
})
