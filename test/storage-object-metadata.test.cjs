/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const { createStorageObjectMetadataHeaders } = require("../src/lib/storage-object-metadata.cjs")

const routeSource = fs.readFileSync(
  path.join(__dirname, "../src/app/api/v1/storage/object/[...key]/route.ts"),
  "utf8"
)

test("HEAD preserves authoritative object size outside normalized Content-Length", () => {
  assert.match(routeSource, /createStorageObjectMetadataHeaders\(head\.ContentLength\)/)
})

test("ten thousand object sizes survive the HEAD metadata contract exactly", () => {
  let state = 0x5eed1234
  for (let scenario = 0; scenario < 10_000; scenario += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const size = state * 1_048_576 + scenario
    const headers = createStorageObjectMetadataHeaders(size)
    assert.equal(headers["Content-Length"], String(size))
    assert.equal(headers["X-Drive-Object-Size"], String(size))
  }
})

test("invalid object sizes are never emitted as authoritative metadata", () => {
  for (const size of [undefined, null, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(createStorageObjectMetadataHeaders(size), {})
  }
})
