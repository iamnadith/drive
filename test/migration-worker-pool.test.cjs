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
