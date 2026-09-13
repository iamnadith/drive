const { test } = process.getBuiltinModule("node:test")
const assert = process.getBuiltinModule("node:assert/strict")
const fs = process.getBuiltinModule("node:fs")
const path = process.getBuiltinModule("node:path")

const root = path.resolve(__dirname, "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

test("dashboard data stores use the shared PostgreSQL layer without Supabase clients", () => {
  for (const file of [
    "src/lib/accounts-store.ts",
    "src/lib/ambient-theme-store.ts",
    "src/lib/agents-store.ts",
    "src/lib/bucket-scan-store.ts",
    "src/lib/bucket-stats-store.ts",
    "src/lib/migration-failure-records-store.ts",
    "src/lib/migrations-store.ts",
    "src/lib/repair-jobs-store.ts",
    "src/lib/users-store.ts",
    "src/lib/email-verification.ts",
    "src/lib/sms-verification.ts",
  ]) {
    const source = read(file)
    assert.match(source, /from ["']\.\/db["']|from ["']@\/lib\/db["']/)
    assert.doesNotMatch(source, /getSupabaseServerClient|@supabase\/supabase-js/)
  }

  const analytics = read("src/app/api/dashboard/analytics/route.ts")
  assert.match(analytics, /from ["']@\/lib\/db["']/)
  assert.doesNotMatch(analytics, /getSupabaseServerClient|@supabase\/supabase-js/)
  const accounts = read("src/lib/accounts-store.ts")
  assert.match(accounts, /export async function updateAccount[\s\S]*withDbTransaction/)
  assert.match(accounts, /export async function deleteAccount[\s\S]*withDbTransaction/)
  const emailVerification = read("src/lib/email-verification.ts")
  const smsVerification = read("src/lib/sms-verification.ts")
  assert.match(emailVerification, /crypto\.timingSafeEqual/)
  assert.match(smsVerification, /crypto\.timingSafeEqual/)
  assert.match(read("src/app/layout.tsx"), /const ambientThemeSettings = await getAmbientThemeSettings\(\)/)
})

test("repair worker claims are atomic and dashboard reads do not reconcile against GitHub", () => {
  const source = read("src/lib/repair-jobs-store.ts")
  assert.match(source, /for update\s+skip locked/i)
  assert.match(source, /returning job\.\*/i)
  assert.match(source, /export async function listRepairJobs\(limit = 50\): Promise<DriveRepairJob\[]> \{\s+return listRepairJobsRaw\(limit\)/)
  assert.match(source, /export async function getRepairJob\(id: string\): Promise<DriveRepairJob \| null> \{\s+return getRepairJobRaw\(id\)/)
})

test("runtime PostgreSQL uses the pooled URL first and keeps the process pool bounded", () => {
  const source = read("src/lib/db.ts")
  assert.match(source, /getEnv\("POSTGRES_URL"\)\s*\?\?\s*getEnv\("POSTGRES_PRISMA_URL"\)\s*\?\?\s*getEnv\("POSTGRES_URL_NON_POOLING"\)/)
  assert.match(source, /process\.env\.NODE_ENV === "production" \? 2 : 1/)
  assert.match(source, /getEnv\("POSTGRES_SSL"\).*\?\? true/)
})

test("dashboard migration routes read persisted scanner evidence and delegate cycles to the orchestrator", () => {
  const syncRoute = read("src/app/api/migrations/[id]/sync/route.ts")
  assert.match(syncRoute, /settings\.orchestratorUrl.*\/wake|\$\{settings\.orchestratorUrl\}\/wake/)
  assert.doesNotMatch(syncRoute, /runBucketScanBatch|computeAndStoreVerifyDiffs|r2ListAllObjects|r2HeadObject/)

  const failuresRoute = read("src/app/api/migrations/[id]/items/[itemId]/failures/route.ts")
  assert.match(failuresRoute, /listMigrationItemFailureRecords/)
  assert.doesNotMatch(failuresRoute, /runBucketScanBatch|ensureBucketScan|inferVerifyDiffsFromScans|r2ListAllObjects|probeObject\(/)
  assert.doesNotMatch(read("src/app/dashboard/migrations/[id]/page.tsx"), /failures\?limit=250&refresh=1/)
})
