const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const read = (file) => fs.readFileSync(file, 'utf8')

test('worker pool claims are generation-scoped and can signal clean completion', () => {
  const claimRoute = read('src/app/api/agents/[id]/claim-job/route.ts')
  const queue = read('src/lib/repair-jobs-store.ts')
  const runtime = read('workers/migration-worker/migration-worker.mjs')

  assert.match(claimRoute, /body\.pool === true/)
  assert.match(claimRoute, /getMigrationWorkerPoolState/)
  assert.match(claimRoute, /poolComplete: true/)
  assert.match(queue, /generation:\$\{poolCoordinates\.generation\}:inventory:%/)
  assert.match(queue, /all_migration_files_completed/)
  assert.match(queue, /migration_file_jobs_terminal/)
  assert.match(runtime, /claimed\?\.poolComplete === true/)
  assert.match(runtime, /DEFAULT_EXIT_AFTER_JOB = POOL_MODE \? "false"/)
  assert.match(runtime, /payload\.migration\?\.options\?\.overwrite !== false/)
  assert.match(runtime, /reason: "overwrite_disabled"/)
})

test('a completed GitHub pool file releases the run link for the next file', () => {
  const jobsRoute = read('src/app/api/agents/[id]/jobs/[jobId]/route.ts')
  assert.match(jobsRoute, /job\.payload\?\.kind === "migration_inventory_file"/)
  assert.match(jobsRoute, /jobReference: null/)
  assert.match(jobsRoute, /summary: `Migration file/)
  assert.match(jobsRoute, /keepPoolRunAlive\s*\?\s*"online"/)
})

test('the GitHub workflow exposes no manual dispatch fields and receives system context', () => {
  const workflow = read('.github/workflows/migration-worker.yml')
  assert.doesNotMatch(workflow, /workflow_dispatch:/)
  assert.match(workflow, /repository_dispatch:/)
  assert.match(workflow, /DRIVE_REPAIR_JOB_ID: \$\{\{ github\.event\.client_payload\.repair_job_id \|\| '' \}\}/)
  assert.doesNotMatch(workflow, /DRIVE_REPAIR_JOB_ID:.*vars\.DRIVE_REPAIR_JOB_ID/)
})

test('orchestrator binds the migration id as one PostgreSQL type while materializing file jobs', () => {
  const orchestrator = read('workers/migration-orchestrator/src/index.ts')
  assert.match(orchestrator, /values\(gen_random_uuid\(\),\$1::uuid,'pending','migration'/)
  assert.match(orchestrator, /format\('migration:%s:generation:%s:inventory:%s:%s',\$1::uuid/)
  assert.doesNotMatch(orchestrator, /format\('migration:%s:generation:%s:inventory:%s:%s',\$1::text/)
})

test('orchestrator dispatches the fleet as soon as durable file jobs are available', () => {
  const orchestrator = read('workers/migration-orchestrator/src/index.ts')
  assert.match(orchestrator, /const hasRunnableFiles = shards\.shardCount > 0 \|\| shards\.created > 0/)
  assert.match(orchestrator, /status === "running" && hasRunnableFiles \? await dispatchWorkers/)
  assert.doesNotMatch(orchestrator, /!shards\.inventoryPending && !shards\.queuePending \? await dispatchWorkers/)
})

test('orchestrator queues scanner pages incrementally without closing a running inventory', () => {
  const orchestrator = read('workers/migration-orchestrator/src/index.ts')
  assert.doesNotMatch(orchestrator, /if \(inventoryPending\) return \{ generation, shardCount: 0, created: 0, inventoryPending \}/)
  assert.match(orchestrator, /queueScan\?\.status === "completed" && page\.rowCount === 0/)
  assert.match(orchestrator, /jsonb_build_object\('status',s\.status,'objects',s\.objects,'bytes',s\.bytes/)
  assert.match(orchestrator, /temporarily empty running scan block another bucket/)
})

test('worker file records stay internal while workflow instances carry current work telemetry', () => {
  const workerPage = read('src/app/dashboard/workers/page.tsx')
  const workerApi = read('src/app/api/workers/route.ts')
  const repairApi = read('src/app/api/repair-jobs/route.ts')
  assert.doesNotMatch(workerPage, /Migration Worker Pool/)
  assert.match(workerPage, /currentWork/)
  assert.match(workerApi, /currentWork:/)
  assert.match(repairApi, /filter\(\(job\) => job\.mode !== "migration"\)/)
})

test('active worker migrations cannot be frozen by historical read-only markers', () => {
  const readOnly = read('src/lib/migration-read-only.ts')
  const detailsRoute = read('src/app/api/migrations/[id]/route.ts')
  const detailsPage = read('src/app/dashboard/migrations/[id]/page.tsx')
  assert.match(readOnly, /terminal && migration\.options\?\.historyReadOnlyAt/)
  assert.match(detailsRoute, /executionMode !== "migration_workers"/)
  assert.match(detailsPage, /executionMode === "migration_workers"\) return/)
})

test('migration orchestrator projects durable per-file completion into live bucket counts', () => {
  const orchestrator = read('workers/migration-orchestrator/src/index.ts')
  assert.match(orchestrator, /async function refreshWorkerItemProgress/)
  assert.match(orchestrator, /'transferredObjects',coalesce\(a\.completed_objects,0\)/)
  assert.match(orchestrator, /await refreshWorkerItemProgress\(db, migration, shards\.generation\)/)
})
