/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

test("retention policy keeps compact summaries and bounds temporary records", () => {
  const source = read("src/lib/database-maintenance.ts")

  assert.match(source, /API_EVENT_RETENTION_DAYS = 7/)
  assert.match(source, /OBJECT_CHANGE_RETENTION_DAYS = 7/)
  assert.match(source, /SCAN_DETAIL_RETENTION_DAYS = 7/)
  assert.match(source, /summary_item_count = totals\.item_count/)
  assert.match(source, /'workerRuns', coalesce/)
  assert.match(source, /delete from drive_agent_runs a/)
  assert.match(source, /details_compacted_at = now\(\)/)
  assert.match(source, /delete from drive_migration_items where migration_id = any/)
  assert.match(source, /m\.created_at < c\.created_at/)
})

test("bucket history writes only changes and permanent deletion tombstones", () => {
  const source = read("src/lib/bucket-stats-store.ts")
  const schema = read("supabase/drive_schema.sql")

  assert.match(schema, /create table if not exists drive_bucket_stat_history/)
  assert.match(schema, /previous_objects bigint/)
  assert.match(schema, /object_delta bigint/)
  assert.match(schema, /previous_bytes bigint/)
  assert.match(schema, /byte_delta bigint/)
  assert.match(source, /latest\.objects is distinct from \$3/)
  assert.match(source, /latest\.bytes is distinct from \$4/)
  assert.match(source, /when \$5::boolean then 'deleted'/)
})
