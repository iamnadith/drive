const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const storePath = path.join(__dirname, "..", "src", "lib", "bucket-dashboard-store.ts")
const source = ts.transpileModule(fs.readFileSync(storePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function loadStore(rows) {
  const calls = []
  const module = { exports: {} }
  const dependencies = {
    "./db": {
      queryDb: async (sql, params) => {
        calls.push({ sql, params })
        return { rows }
      },
    },
    "./bucket-settings-snapshot-store": {
      serializeBucketSettingsSnapshot: (row) => ({
        accountId: row.account_id,
        bucketName: row.bucket_name,
        settingsStatus: row.settings_status,
        settings: row.cors_rules,
      }),
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

test("bucket page bootstrap combines active account and cached bucket projections in one query", async () => {
  const store = loadStore([{
    id: "account-1",
    label: "Main",
    status: "active",
    cloudflare_account_id: "cf-1",
    total_buckets: "1",
    total_objects: "12",
    total_bytes: "4096",
    last_synced_at: "2026-09-14T00:00:00.000Z",
    sync_status: "ok",
    sync_message: null,
    buckets: [{
      name: "media",
      snapshot: {
        account_id: "account-1",
        bucket_name: "media",
        settings_status: "completed",
        cors_rules: [{ allowedOrigins: ["https://app.example"] }],
      },
      objects: "12",
      bytes: "4096",
      statsStatus: "completed",
      statsError: null,
      statsUpdatedAt: "2026-09-14T00:00:00.000Z",
      publicAccessEnabled: false,
      mediaAllowedOrigins: ["https://app.example"],
      deliveryCreatedAt: null,
      deliveryUpdatedAt: null,
      projects: [{
        id: "project-1",
        projectId: "p1",
        name: "Photos",
        status: "active",
        mediaAllowedOrigins: ["https://app.example"],
      }],
    }],
  }])

  const result = await store.getBucketDashboardBootstrap()
  assert.equal(store.calls.length, 1)
  assert.equal(store.calls[0].params, undefined)
  assert.match(store.calls[0].sql, /drive_bucket_settings_snapshots/)
  assert.match(store.calls[0].sql, /drive_bucket_stats/)
  assert.match(store.calls[0].sql, /drive_bucket_delivery_settings/)
  assert.match(store.calls[0].sql, /drive_project_delivery_settings/)
  assert.equal(result.account.id, "account-1")
  assert.equal(result.buckets[0].objects, 12)
  assert.equal(result.buckets[0].bytes, 4096)
  assert.equal(result.buckets[0].publicAccessEnabled, false)
  assert.equal(result.buckets[0].snapshot.bucketName, "media")
  assert.equal(result.buckets[0].projects[0].projectId, "p1")
})

test("bucket bootstrap reports no active account without a second database query", async () => {
  const store = loadStore([])
  assert.equal(await store.getBucketDashboardBootstrap(), null)
  assert.equal(store.calls.length, 1)
})
