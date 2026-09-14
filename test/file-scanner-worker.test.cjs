const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const read = (path) => fs.readFileSync(path, 'utf8')

test('the orchestrator creates scan work while scanner cron and queue continue durable tasks', () => {
  const scanner = read('workers/file-scanner/src/index.ts')
  const config = read('workers/file-scanner/wrangler.jsonc')
  const orchestrator = read('workers/migration-orchestrator/src/index.ts')
  assert.match(config, /"crons":\s*\["\* \* \* \* \*"\]/)
  assert.match(scanner, /async scheduled\(_event: ScheduledEvent, env: Env, ctx: ExecutionContext\)[\s\S]*?cycleAndContinue\(env\)/)
  assert.match(orchestrator, /async function wakeFileScanner\(db: Client\)[\s\S]*?\/run/)
  assert.match(scanner, /url\.pathname === "\/run" && request\.method === "POST"[\s\S]*?cycleAndContinue\(env\)/)
  assert.doesNotMatch(scanner, /url\.pathname === "\/status" && request\.method === "GET"[^\n]*cycle/)
  assert.match(scanner, /let schemaReady: Promise<void> \| null = null/)
})

test('migration scanner uses maximum R2 page size and avoids whole-inventory recounts per page', () => {
  const scanner = read('workers/file-scanner/src/index.ts')
  const persist = scanner.slice(scanner.indexOf('async function persistMigrationPage'), scanner.indexOf('async function compare('))
  const generic = scanner.slice(scanner.indexOf('async function processGenericScan'), scanner.indexOf('async function finishState'))
  assert.match(scanner, /function pageSize\(_env: Env\) \{ return 1000 \}/)
  assert.match(persist, /object_delta/)
  assert.match(persist, /byte_delta/)
  assert.match(persist, /on conflict\(scan_id,key\) do update/)
  assert.match(persist, /from drive_migration_verification_state[\s\S]*?for update/)
  assert.match(persist, /greatest\(0,coalesce\(s\.objects,0\)\+d\.object_delta\)/)
  assert.match(persist, /greatest\(0,coalesce\(v\.\$\{objectsColumn\},0\)\+d\.object_delta\)/)
  assert.match(persist, /begin[\s\S]*?commit[\s\S]*?rollback/)
  assert.doesNotMatch(persist, /select count\(\*\).*drive_bucket_scan_objects/i)
  assert.match(generic, /await pageDelta\(db, task\.id, objects\)/)
  assert.doesNotMatch(generic, /select count\(\*\).*drive_bucket_scan_objects/i)
})

test('scanner completion wakes the Migration Orchestrator asynchronously', () => {
  const scanner = read('workers/file-scanner/src/index.ts')
  const wake = scanner.slice(scanner.indexOf('async function wakeMigrationOrchestrator'), scanner.indexOf('async function compareAndWake'))
  assert.match(wake, /\/wake/)
  assert.doesNotMatch(wake, /\/run/)
})

test('empty migrations complete in the orchestrator without requiring scanner or Slurper work', () => {
  const orchestrator = read('workers/migration-orchestrator/src/index.ts')
  const emptyWorkerPath = orchestrator.slice(orchestrator.indexOf('async function ensureShards'), orchestrator.indexOf('let inventoryPending'))
  const cycle = orchestrator.slice(orchestrator.indexOf('async function cycle('), orchestrator.indexOf('export default'))
  assert.match(emptyWorkerPath, /if \(!hasItems\.rowCount\)[\s\S]*?noItems: true/)
  assert.match(cycle, /const inventory = await ensureSuperSlurperInventory\(db, migration\)[\s\S]*?if \(inventory\.total === 0\)[\s\S]*?activateTargetAndCompleteMigration/)
  assert.match(cycle, /if \(shards\.noItems\)[\s\S]*?activateTargetAndCompleteMigration/)
  assert.doesNotMatch(emptyWorkerPath, /ensureWorkerTargetBuckets\(db, migration, generation\)[\s\S]*?if \(!hasItems\.rowCount\)/)
})

test('empty and verified migrations share the existing target activation and completion transaction', () => {
  const orchestrator = read('workers/migration-orchestrator/src/index.ts')
  const activation = orchestrator.slice(orchestrator.indexOf('async function activateTargetAndCompleteMigration'), orchestrator.indexOf('async function finishOrRepair'))
  assert.match(activation, /status=case when a\.id=\$1 then 'active' when a\.status='active' then 'available'/)
  assert.match(activation, /status='completed',completed_at=now\(\),sync_status='synced'/)
  assert.match(activation, /summary_item_count=\(select count\(\*\) from drive_migration_items/)
  assert.match(activation, /await wakeBackendOrchestrator\(db\)/)
})

test('Migration Orchestrator owns Super Slurper job creation', () => {
  const orchestrator = read('workers/migration-orchestrator/src/index.ts')
  const creation = orchestrator.slice(orchestrator.indexOf('async function createSuperSlurperJobs'), orchestrator.indexOf('async function syncNextBucketSettings'))
  const cycle = orchestrator.slice(orchestrator.indexOf('async function cycle('), orchestrator.indexOf('export default'))
  assert.match(creation, /cloudflare\(target, "\/slurper\/jobs", "POST"/)
  assert.match(cycle, /const jobs = await createSuperSlurperJobs\(db, migration\)/)
})
