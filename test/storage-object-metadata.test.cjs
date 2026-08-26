/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const routeSource = fs.readFileSync(
  path.join(__dirname, "../src/app/api/v1/storage/object/[...key]/route.ts"),
  "utf8"
)

test("HEAD preserves authoritative object size outside normalized Content-Length", () => {
  assert.match(routeSource, /"X-Drive-Object-Size": String\(head\.ContentLength\)/)
  assert.match(routeSource, /typeof head\.ContentLength === "number"/)
})
