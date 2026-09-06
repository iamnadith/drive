const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.join(__dirname, "..")
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8")

test("bucket assignments allow the same bucket across multiple projects", () => {
  for (const relativePath of ["src/lib/projects-store.ts", "src/lib/db.ts", "supabase/drive_schema.sql"]) {
    const source = read(relativePath)
    assert.match(source, /drop index if exists drive_project_bucket_assignments_bucket_key/i)
    assert.doesNotMatch(
      source,
      /create unique index if not exists drive_project_bucket_assignments_bucket_key/i
    )
    assert.doesNotMatch(source, /create unique index[^;]*drive_projects_bucket_name_key/i)
  }
})

test("shared bucket policy resolution considers every assigned project", () => {
  const projectsStore = read("src/lib/projects-store.ts")
  const deliveryService = read("src/lib/bucket-delivery-settings-service.ts")

  assert.match(projectsStore, /export async function getAssignedProjectIdsForBucket/)
  assert.match(projectsStore, /rows\.map\(\(row\) => row\.project_id\)/)
  assert.match(deliveryService, /getAssignedProjectIdsForBucket\(accountId, bucketName\)/)
  assert.match(deliveryService, /listProjectDeliverySettings\(projectIds\)/)
  assert.match(deliveryService, /mergeManyMediaAllowedOrigins\(inheritedPolicies\)/)
})

test("project deletion preserves buckets still assigned elsewhere", () => {
  const route = read("src/app/api/projects/[id]/route.ts")
  assert.match(route, /const sharedBuckets = assignedBuckets\.filter/)
  assert.match(route, /const bucketsToDelete = deleteBucket/)
  assert.match(route, /keptSharedBuckets: sharedBuckets\.length/)
})

test("managed delivery CORS updates preserve unrelated provider rules", () => {
  const settings = read("src/lib/r2-bucket-settings.ts")
  assert.match(settings, /const genericRules = rules\.filter\(\(rule\) => rule\.id !== MANAGED_MEDIA_CORS_RULE_ID\)/)
  assert.match(settings, /return \[\s*\.\.\.genericRules,/)
  assert.match(settings, /const managed = current\.find\(\(rule\) => rule\.id === MANAGED_MEDIA_CORS_RULE_ID\)/)
})

test("project and bucket delivery state use one managed policy that is updated in place", () => {
  const schema = read("supabase/drive_schema.sql")
  const projectSettings = read("src/lib/project-delivery-settings-store.ts")
  const r2Settings = read("src/lib/r2-bucket-settings.ts")
  assert.match(schema, /project_id uuid primary key references drive_projects\(id\)/i)
  assert.match(projectSettings, /on conflict \(project_id\) do update set/i)
  assert.match(r2Settings, /rules\.filter\(\(rule\) => rule\.id !== MANAGED_MEDIA_CORS_RULE_ID\)/)
  assert.match(r2Settings, /id: MANAGED_MEDIA_CORS_RULE_ID/)
})

test("project-wide synchronization attempts every assigned bucket and reports failures", () => {
  const service = read("src/lib/bucket-delivery-settings-service.ts")
  assert.match(service, /for \(const bucket of buckets\.filter/)
  assert.match(service, /failures\.push\(\{ bucketName: bucket\.bucketName, error \}\)/)
  assert.match(service, /throw new AggregateError/)
})

test("background reconciliation is durable and skips provider writes when the managed rule already matches", () => {
  const service = read("src/lib/bucket-delivery-settings-service.ts")
  const r2Settings = read("src/lib/r2-bucket-settings.ts")
  const panelRoute = read("src/app/api/internal/backend-orchestrator/reconcile/route.ts")
  const worker = read("workers/backend-orchestrator/src/index.ts")

  assert.match(service, /drive_project_delivery_sync_state/)
  assert.match(service, /where assignment\.account_id = \$1/)
  assert.match(service, /order by state\.last_checked_at asc nulls first/)
  assert.match(r2Settings, /if \(corsRulesEqual\(current, desired\)\) return \{ changed: false, rules: current \}/)
  assert.match(panelRoute, /reconcileAssignedProjectDeliveryCors/)
  assert.match(worker, /project\/bucket[\s\S]*single managed R2 CORS rule[\s\S]*only[\s\S]*differs/)
})

test("shared bucket access and delivery rules are isolated by Cloudflare account", () => {
  const projectsStore = read("src/lib/projects-store.ts")
  const storageRoute = read("src/app/storage/[bucket]/[...key]/route.ts")
  assert.match(projectsStore, /account_id uuid references drive_accounts\(id\)/i)
  assert.match(projectsStore, /where assignment\.account_id = \$1 and assignment\.bucket_name = \$2/i)
  assert.match(projectsStore, /where a\.account_id = \$1 and a\.bucket_name = \$2/i)
  assert.match(storageRoute, /listProjectsUsingBucket\(active\.id, bucket\)/)
  assert.match(storageRoute, /authorizeProjectRequest\(request, candidate\.projectId, "read"\)/)
})

test("assignment mutations queue durable reconciliation before removals", () => {
  const route = read("src/app/api/projects/[id]/buckets/route.ts")
  const queuePosition = route.lastIndexOf("queueBucketDeliveryCorsReconciliation")
  const removePosition = route.lastIndexOf("removeProjectBucket")
  assert.ok(queuePosition > -1 && removePosition > -1 && queuePosition < removePosition)
  assert.match(route, /deliverySyncPending/)
})

test("primary bucket changes are transactional and cannot create two primaries", () => {
  const projectsStore = read("src/lib/projects-store.ts")
  const db = read("src/lib/db.ts")
  assert.match(projectsStore, /withDbTransaction/)
  assert.match(projectsStore, /set is_primary = false where project_id = \$1/)
  assert.match(projectsStore, /set is_primary = true where project_id = \$1 and bucket_name = \$2/)
  assert.match(db, /export async function withDbTransaction/)
})

test("accepted delivery policy remains desired state when provider sync is delayed", () => {
  const projectRoute = read("src/app/api/projects/[id]/route.ts")
  const bucketService = read("src/lib/bucket-delivery-settings-service.ts")
  assert.match(projectRoute, /queueBucketDeliveryCorsReconciliation/)
  assert.match(projectRoute, /deliverySyncPending = true/)
  assert.doesNotMatch(projectRoute, /Unable to roll back bucket delivery settings/)
  assert.match(bucketService, /worker keeps verifying it until it matches/)
  assert.match(bucketService, /state\.next_attempt_at is null or state\.next_attempt_at <= now\(\)/)
})

test("bucket and project settings expose every effective and provider CORS rule", () => {
  const projectRoute = read("src/app/api/projects/[id]/route.ts")
  const projectsPage = read("src/app/dashboard/projects/page.tsx")
  const bucketsPage = read("src/app/dashboard/buckets/page.tsx")
  assert.match(projectRoute, /bucketDeliveryRules/)
  assert.match(projectsPage, /Rules on assigned buckets/)
  assert.match(bucketsPage, /All applied R2 CORS rules/)
  assert.match(bucketsPage, /Preserved provider rule/)
})
