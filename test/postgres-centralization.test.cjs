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

test("runtime PostgreSQL uses only POSTGRES_URL and keeps the process pool bounded", () => {
  const source = read("src/lib/db.ts")
  assert.match(source, /const connectionString = getEnv\("POSTGRES_URL"\)/)
  assert.match(source, /connectionString,\s*ssl: buildSslConfig\(\)/)
  assert.match(source, /return Boolean\(getEnv\("POSTGRES_URL"\)\)/)
  assert.match(source, /var __drivePgAdvisoryLockPool: Pool \| undefined/)
  assert.match(source, /const client = await global\.__drivePgAdvisoryLockPool\.connect\(\)/)
  assert.match(source, /process\.env\.NODE_ENV === "production" \? 2 : 1/)
  assert.match(source, /getEnv\("POSTGRES_SSL"\).*\?\? true/)
  assert.match(source, /getEnv\("DISABLE_POSTGRES_SSL"\).*\?\? false/)
  for (const route of [
    "src/app/api/internal/backend-orchestrator/config/route.ts",
    "src/app/api/internal/file-scanner/config/route.ts",
    "src/app/api/internal/migration-orchestrator/config/route.ts",
  ]) {
    assert.match(read(route), /process\.env\.POSTGRES_URL/)
  }
  const backendWorker = read("workers/backend-orchestrator/src/index.ts")
  assert.match(backendWorker, /ssl:\s*disablePostgresSsl\s*\?\s*false\s*:\s*\{\s*rejectUnauthorized:\s*false\s*\}/)
  assert.doesNotMatch(backendWorker, /isSupabase|supabase\.com/)
  const schemaInstaller = read("scripts/prepare-schema.mjs")
  assert.doesNotMatch(schemaInstaller, /supabase\.co|prefersDirectSupabase/i)
  assert.match(schemaInstaller, /const url = value\("POSTGRES_URL"\)/)
  assert.match(schemaInstaller, /Set POSTGRES_URL in the build environment/)
  assert.match(schemaInstaller, /booleanValue\("DISABLE_POSTGRES_SSL", false\)/)
})

test("users page is server-paginated with safe columns and analytics reads only user aggregates", () => {
  const usersStore = read("src/lib/users-store.ts")
  const pagedUsers = usersStore.match(/export async function listUsersPage\([\s\S]*?\n}\n\nexport async function hasAnyUsers/)
  assert.ok(pagedUsers, "expected a bounded users-page query")
  assert.match(pagedUsers[0], /limit greatest\(0,/i)
  assert.match(pagedUsers[0], /order by u\.created_at asc,u\.id asc/i)
  assert.match(pagedUsers[0], /count\(\*\) filter \(where status='active'\)/i)
  assert.doesNotMatch(pagedUsers[0], /select\s+\*\s+from\s+public\.drive_users|password_hash|totp_secret/i)
  assert.doesNotMatch(usersStore, /export async function (getAllUsers|searchUsers)\(/)

  const usersRoute = read("src/app/api/users/route.ts")
  assert.match(usersRoute, /listUsersPage\(/)
  assert.match(usersRoute, /searchParams\.get\("page"\)/)
  assert.match(usersRoute, /searchParams\.get\("limit"\)/)

  const analytics = read("src/app/api/dashboard/analytics/route.ts")
  assert.match(analytics, /getUserSummary/)
  assert.match(analytics, /listDashboardAccountSummaries/)
  assert.doesNotMatch(analytics, /getAllAccounts/)
  assert.doesNotMatch(analytics, /getAllUsers|type User from ["']@\/lib\/users-store/)
  assert.match(analytics, /itemMetricsByDay/)
  assert.doesNotMatch(analytics, /itemRowsAsItems\.filter\(|migrations\.filter\(\(m\) => dateKey/)
  assert.doesNotMatch(analytics, /Math\.min\(\.\.\.times\)/)
})

test("analytics aggregates bucket and verification summaries in one database round trip", () => {
  const analytics = read("src/app/api/dashboard/analytics/route.ts")
  const summaryStart = analytics.indexOf("async function getAnalyticsSqlSummary()")
  const summaryEnd = analytics.indexOf("async function listActiveAccountSnapshots()", summaryStart)
  assert.ok(summaryStart >= 0 && summaryEnd > summaryStart, "expected the consolidated analytics query")
  const summary = analytics.slice(summaryStart, summaryEnd)
  assert.equal((summary.match(/queryDb</g) ?? []).length, 1)
  assert.match(summary, /bucket_status_counts as/i)
  assert.match(summary, /join active_account/i)
  assert.match(summary, /order by created_at desc\s+limit 25/i)
  assert.match(summary, /order by updated_at desc nulls first[\s\S]*?limit 10/i)
  assert.match(summary, /drive_migration_item_failure_records/i)
  assert.match(summary, /count\(\*\)::text from public\.drive_bucket_verify_diffs/i)
  assert.match(analytics, /ANALYTICS_ITEM_PROGRESS_SQL/)
  assert.match(analytics, /\$\{ANALYTICS_ITEM_PROGRESS_SQL\} as progress/)
  assert.doesNotMatch(analytics, /selectRows<BucketStatsRow>/)
  assert.doesNotMatch(analytics, /countRows\(/)
})

test("migrations page bootstrap uses one safe, database-snapshot endpoint", () => {
  const route = read("src/app/api/migrations/route.ts")
  const getStart = route.indexOf("export async function GET()")
  const getEnd = route.indexOf("export async function POST(", getStart)
  assert.ok(getStart >= 0 && getEnd > getStart, "expected migrations bootstrap GET")
  const getHandler = route.slice(getStart, getEnd)
  assert.match(getHandler, /listDashboardAccountSummaries/)
  assert.match(getHandler, /listActiveBucketStats/)
  assert.match(getHandler, /listMigrationItems\(current\.id\)/)
  assert.match(getHandler, /accounts: accounts\.map\(\(\{ id, label, email, status \}\)/)
  assert.doesNotMatch(getHandler, /apiToken|r2SecretAccessKey|password/)

  const page = read("src/app/dashboard/migrations/page.tsx")
  const loadStart = page.indexOf("const loadAll = React.useCallback")
  const loadEnd = page.indexOf("const confirmDelete =", loadStart)
  assert.ok(loadStart >= 0 && loadEnd > loadStart, "expected migrations dashboard bootstrap")
  const load = page.slice(loadStart, loadEnd)
  assert.equal((load.match(/fetch\(/g) ?? []).length, 1)
  assert.match(load, /fetch\("\/api\/migrations"/)
  assert.doesNotMatch(load, /\/api\/accounts|\/api\/storage\/buckets|\/api\/migrations\/\$\{encodeURIComponent\(current\.id\)\}/)

  const bucketStore = read("src/lib/bucket-stats-store.ts")
  const activeReaderStart = bucketStore.indexOf("export async function listActiveBucketStats()")
  const activeReaderEnd = bucketStore.indexOf("export async function getBucketStatsMap(", activeReaderStart)
  assert.ok(activeReaderStart >= 0 && activeReaderEnd > activeReaderStart)
  assert.match(bucketStore.slice(activeReaderStart, activeReaderEnd), /account\.status='active'/)
})

test("migration detail bootstrap loads safe account options with its initial payload", () => {
  const route = read("src/app/api/migrations/[id]/route.ts")
  const getStart = route.indexOf("export async function GET(")
  const deleteStart = route.indexOf("export async function DELETE(", getStart)
  assert.ok(getStart >= 0 && deleteStart > getStart)
  const getHandler = route.slice(getStart, deleteStart)
  assert.match(getHandler, /listDashboardAccountSummaries\(\)/)
  assert.match(getHandler, /const accounts = accountSummaries\.map\(\(\{ id: accountId, label, email, status \}\)/)
  assert.doesNotMatch(getHandler, /apiToken|r2SecretAccessKey|password/)

  const page = read("src/app/dashboard/migrations/[id]/page.tsx")
  const loadStart = page.indexOf("const loadInitial = React.useCallback")
  const loadEnd = page.indexOf("const runMigrationAction =", loadStart)
  assert.ok(loadStart >= 0 && loadEnd > loadStart)
  const load = page.slice(loadStart, loadEnd)
  assert.equal((load.match(/fetch\(/g) ?? []).length, 1)
  assert.match(load, /detailsJson\.accounts/)
  assert.doesNotMatch(load, /\/api\/accounts/)
})

test("API usage aggregates are page-stable and use one bounded database request", () => {
  const operations = read("src/lib/project-operations-store.ts")
  const start = operations.indexOf("export async function getProjectApiUsage(")
  const end = operations.indexOf("export async function createProjectOperationJob(", start)
  assert.ok(start >= 0 && end > start, "expected the API usage store")
  const usage = operations.slice(start, end)
  assert.equal((usage.match(/queryDb</g) ?? []).length, 1)
  assert.match(usage, /filtered_events as materialized/i)
  assert.match(usage, /const filterWhere = filterClauses/)
  assert.match(usage, /const pageClauses = \[\.\.\.filterClauses\]/)
  assert.match(usage, /pageClauses\.push\(`\(e\.occurred_at, e\.id\)/)
  assert.match(operations, /drive_project_api_events_occurred_id_idx/)
})

test("project details read synchronized bucket snapshots without per-bucket provider calls", () => {
  const route = read("src/app/api/projects/[id]/route.ts")
  const start = route.indexOf("export async function GET(")
  const end = route.indexOf("export async function PATCH(", start)
  assert.ok(start >= 0 && end > start, "expected the project details GET handler")
  const getHandler = route.slice(start, end)
  assert.match(getHandler, /listBucketSettingsSnapshots/)
  assert.match(getHandler, /listBucketDeliverySettings/)
  assert.match(getHandler, /listAssignedProjectsForBuckets/)
  assert.match(getHandler, /getActiveAccountId/)
  assert.doesNotMatch(getHandler, /getActiveAccount\(/)
  assert.doesNotMatch(getHandler, /readBucketSettings|upsertBucketSettingsSnapshot|getEffectiveBucketMediaOrigins\(/)
  assert.doesNotMatch(getHandler, /Promise\.all\(scopedBuckets\.map/)
})

test("project bucket subpage loads its project, assignments, and available names in one database query", () => {
  const projects = read("src/lib/projects-store.ts")
  const start = projects.indexOf("export async function getProjectBucketManagementData(")
  const end = projects.indexOf("export async function getProjectBucketAssignment(", start)
  assert.ok(start >= 0 && end > start, "expected the project bucket management query")
  const query = projects.slice(start, end)
  assert.equal((query.match(/queryDb</g) ?? []).length, 1)
  assert.match(query, /drive_project_bucket_assignments/)
  assert.match(query, /drive_bucket_stats/)
  assert.match(query, /drive_accounts/)

  const route = read("src/app/api/projects/[id]/buckets/route.ts")
  const handlerStart = route.indexOf("export async function GET(")
  const handlerEnd = route.indexOf("export async function POST(", handlerStart)
  assert.match(route.slice(handlerStart, handlerEnd), /getProjectBucketManagementData\(id\)/)
  assert.doesNotMatch(route.slice(handlerStart, handlerEnd), /r2ListBuckets|listProjectBuckets\(/)

  const page = read("src/app/dashboard/projects/[id]/buckets/page.tsx")
  const loadStart = page.indexOf("const loadAll = React.useCallback")
  const loadEnd = page.indexOf("const validation = React.useMemo", loadStart)
  const load = page.slice(loadStart, loadEnd)
  assert.equal((load.match(/fetch\(/g) ?? []).length, 1)
  assert.doesNotMatch(load, /api\/storage\/buckets/)
})

test("project stores reuse versioned central schema readiness instead of replaying DDL on each cold instance", () => {
  const projects = read("src/lib/projects-store.ts")
  const start = projects.indexOf("export async function ensureProjectSchema()")
  const end = projects.indexOf("export async function listProjects()", start)
  assert.ok(start >= 0 && end > start, "expected project schema readiness function")
  assert.match(projects.slice(start, end), /await ensureDriveSchema\(\)/)
  assert.doesNotMatch(projects.slice(start, end), /create table|alter table|update drive_projects/)
})

test("dashboard migration routes read persisted scanner evidence and delegate cycles to the orchestrator", () => {
  const syncRoute = read("src/app/api/migrations/[id]/sync/route.ts")
  assert.match(syncRoute, /settings\.orchestratorUrl.*\/wake|\$\{settings\.orchestratorUrl\}\/wake/)
  assert.doesNotMatch(syncRoute, /runBucketScanBatch|computeAndStoreVerifyDiffs|r2ListAllObjects|r2HeadObject/)

  const failuresRoute = read("src/app/api/migrations/[id]/items/[itemId]/failures/route.ts")
  assert.match(failuresRoute, /listMigrationItemFailureRecords/)
  assert.doesNotMatch(failuresRoute, /runBucketScanBatch|ensureBucketScan|inferVerifyDiffsFromScans|r2ListAllObjects|probeObject\(/)
  assert.doesNotMatch(read("src/app/dashboard/migrations/[id]/page.tsx"), /failures\?limit=250&refresh=1/)

  const migrationStore = read("src/lib/migrations-store.ts")
  const start = migrationStore.indexOf("export async function getMigration(")
  const end = migrationStore.indexOf("export async function listMigrationItems(", start)
  const getMigration = migrationStore.slice(start, end)
  assert.match(getMigration, /left join lateral/i)
  assert.doesNotMatch(getMigration, /\bupdate\s+public\.drive_migrations/i)
})
