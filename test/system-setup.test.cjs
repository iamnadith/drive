const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")
const readiness = read("src/lib/system-readiness.ts")
const setupStatus = read("src/app/api/setup/status/route.ts")
const setupAdmin = read("src/app/api/setup/admin/route.ts")
const workerInstallRoute = read("src/app/api/workers/cloudflare-install/route.ts")
const setupPage = read("src/app/setup/page.tsx")
const gate = read("src/components/superadmin-gate.tsx")
const login = read("src/components/login-form.tsx")
const profile = read("src/app/profile/page.tsx")
const hosting = read("src/components/dashboard/cloudflare-worker-hosting.tsx")
const cron = read("src/app/api/cron/cloudflare-workers/route.ts")
const backendReconcile = read("src/app/api/internal/backend-orchestrator/reconcile/route.ts")
const vercel = read("vercel.json")
const siteHeader = read("src/components/site-header.tsx")

test("setup gates account creation behind required environment and Workers", () => {
  for (const marker of ["POSTGRES_URL", "POSTGRES_SSL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "NEXT_PUBLIC_APP_URL", "CRON_SECRET"]) assert.match(readiness, new RegExp(marker))
  assert.match(readiness, /queryDb\("select 1 as ready"\)/)
  assert.match(setupStatus, /!readiness\.ready \? "requirements" : !workersReady \? "workers" : !hasSuperAdmin \? "account"/)
  assert.match(setupAdmin, /Complete the required environment configuration first/)
  assert.match(setupAdmin, /Deploy and verify all required Workers first/)
  assert.match(workerInstallRoute, /Complete required environment setup first/)
})

test("setup presents responsive ordered stages and Worker telemetry", () => {
  assert.match(setupPage, /Environment/)
  assert.match(setupPage, /Worker foundation/)
  assert.match(setupPage, /Continue to account/)
  assert.match(setupPage, /sm:grid-cols-3/)
  assert.match(hosting, /lastCheckedAt/)
  assert.match(hosting, /latencyMs/)
  assert.match(hosting, /onboarding/)
})

test("runtime guard returns superadmins to setup when reconciliation fails", () => {
  assert.match(gate, /setupRequired/)
  assert.match(gate, /60_000/)
  assert.match(setupStatus, /reconcileCloudflareWorkers/)
  assert.match(cron, /reconcileAndRepairCloudflareWorkers\(true\)/)
  assert.match(cron, /Bearer \$\{secret\}/)
  assert.match(backendReconcile, /after\(async \(\) =>/)
  assert.match(vercel, /api\/cron\/cloudflare-workers/)
})

test("optional Google and SMS controls are capability-aware", () => {
  assert.match(readiness, /google: present\("GOOGLE_CLIENT_ID"\) && present\("GOOGLE_CLIENT_SECRET"\)/)
  assert.match(readiness, /sms: present\("TEXTLK_API_TOKEN", "TEXT_LK_API_TOKEN"\)/)
  assert.match(login, /capabilities\.google/)
  assert.match(profile, /capabilities\.sms/)
  assert.match(profile, /capabilities\.google/)
})

test("setup and authentication flows do not render the global header", () => {
  for (const route of ["/setup", "/login", "/signup", "/auth"]) {
    assert.match(siteHeader, new RegExp(route.replace("/", "\\/")))
  }
  assert.match(siteHeader, /if \(headerlessRoute\)/)
})
