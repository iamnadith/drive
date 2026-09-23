const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const source = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "..", "src", "lib", "migrations-store.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText

function loadStore(row) {
  const calls = []
  const module = { exports: {} }
  const dependencies = {
    crypto: require("node:crypto"),
    "./database-maintenance": { compactPreviousMigrationDetails: async () => {} },
    "./migration-worker-runs": { mapMigrationWorkerRun: (row) => row },
    "./activity-store": { ensureActivitySchema: async () => {}, recordActivityInTransaction: async () => {} },
    "./db": {
      queryDb: async (sql, params) => {
        calls.push({ sql, params })
        return { rows: [row] }
      },
    },
  }
  new Function("require", "module", "exports", source)(
    (name) => {
      if (dependencies[name]) return dependencies[name]
      throw new Error(`Unexpected dependency: ${name}`)
    },
    module,
    module.exports,
  )
  return { ...module.exports, calls }
}

test("migration list bootstrap reads safe account, migration, bucket and current-item projections in one query", async () => {
  const store = loadStore({
    migrations: [{
      id: "migration-1",
      source_account_id: "source-1",
      target_account_id: "target-1",
      status: "running",
      options: { executionMode: "migration_workers" },
      created_at: "2026-09-14T00:00:00.000Z",
      started_at: "2026-09-14T00:01:00.000Z",
      completed_at: null,
      last_synced_at: null,
      sync_status: "idle",
      sync_message: null,
      updated_at: "2026-09-14T00:02:00.000Z",
      summary_item_count: "1",
      summary_objects: "2",
      summary_bytes: "2048",
      worker_summary: {},
      details_compacted_at: null,
    }],
    accounts: [{ id: "source-1", label: "Source", email: "s@example.test", status: "active", cloudflare_account_id: "cf-source" }],
    active_account: { id: "source-1", cloudflare_account_id: "cf-source" },
    bucket_stats: [{ bucket_name: "media", objects: "2", bytes: "2048", status: "completed", error: null, updated_at: "2026-09-14T00:02:00.000Z" }],
    active_items: [{
      id: "item-1",
      migration_id: "migration-1",
      source_bucket: "media",
      target_bucket: "media-copy",
      source_jurisdiction: null,
      source_storage_class: "Standard",
      source_objects: "2",
      source_bytes: "2048",
      slurper_job_id: null,
      slurper_status: null,
      progress: {},
      last_progress_at: null,
      created_at: "2026-09-14T00:01:00.000Z",
      updated_at: null,
    }],
  })

  const result = await store.getMigrationDashboardBootstrap()
  assert.equal(store.calls.length, 1)
  assert.deepEqual(store.calls[0].params, [50])
  assert.match(store.calls[0].sql, /jsonb_agg/)
  assert.match(store.calls[0].sql, /current_migration/)
  assert.match(store.calls[0].sql, /current_migration as \([\s\S]*?select \* from limited_migrations/)
  assert.match(store.calls[0].sql, /join current_migration migration on migration\.id=item\.migration_id/)
  assert.match(store.calls[0].sql, /drive_bucket_stats/)
  assert.match(store.calls[0].sql, /drive_migration_items/)
  assert.doesNotMatch(store.calls[0].sql, /api_token|r2_secret_access_key|password/)
  assert.equal(result.migrations[0].summaryBytes, 2048)
  assert.equal(result.accounts[0].cloudflareAccountId, "cf-source")
  assert.equal(result.bucketStats[0].bytes, 2048)
  assert.equal(result.activeItems[0].sourceBytes, 2048)
})

test("migration bootstrap clamps the migration page query limit", async () => {
  const store = loadStore({ migrations: [], accounts: [], active_account: null, bucket_stats: [], active_items: [] })
  await store.getMigrationDashboardBootstrap(5000)
  assert.deepEqual(store.calls[0].params, [500])
})
