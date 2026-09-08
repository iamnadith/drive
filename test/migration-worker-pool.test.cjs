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
  assert.match(queue, /generation:\$\{poolCoordinates\.generation\}:shard:%/)
  assert.match(queue, /job\.status !== "completed"/)
  assert.match(queue, /reason: "shard_retry_exhausted"/)
  assert.match(runtime, /claimed\?\.poolComplete === true/)
  assert.match(runtime, /DEFAULT_EXIT_AFTER_JOB = POOL_MODE \? "false"/)
  assert.match(runtime, /payload\.migration\?\.options\?\.overwrite !== false/)
  assert.match(runtime, /reason: "overwrite_disabled"/)
})

test('a completed GitHub pool shard releases the run link for the next shard', () => {
  const jobsRoute = read('src/app/api/agents/[id]/jobs/[jobId]/route.ts')
  assert.match(jobsRoute, /job\.payload\?\.kind === "migration_shard"/)
  assert.match(jobsRoute, /jobReference: null/)
  assert.match(jobsRoute, /summary: `Worker pool shard/)
  assert.match(jobsRoute, /keepPoolRunAlive\s*\?\s*"online"/)
})

test('the GitHub workflow does not inject a stale global repair job id', () => {
  const workflow = read('.github/workflows/migration-worker.yml')
  assert.match(workflow, /DRIVE_REPAIR_JOB_ID: \$\{\{ inputs\.repair_job_id \|\| github\.event\.client_payload\.repair_job_id \|\| '' \}\}/)
  assert.doesNotMatch(workflow, /DRIVE_REPAIR_JOB_ID:.*vars\.DRIVE_REPAIR_JOB_ID/)
})
