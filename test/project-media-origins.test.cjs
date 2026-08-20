/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict")
const test = require("node:test")

const {
  hasProjectBucketDeliveryPolicyMutation,
  mergeMediaAllowedOrigins,
  normalizeMediaAllowedOrigins,
} = require("../src/lib/project-media-origins.cjs")

test("normalizes, de-duplicates, and permits localhost development origins", () => {
  assert.deepEqual(
    normalizeMediaAllowedOrigins([
      "https://panel.example.com",
      "https://panel.example.com/",
      "http://localhost:3000",
    ]),
    ["https://panel.example.com", "http://localhost:3000"]
  )
})

test("canonicalizes a wildcard and rejects insecure remote or path-scoped origins", () => {
  assert.deepEqual(normalizeMediaAllowedOrigins(["https://panel.example.com", "*"]), ["*"])
  for (const invalid of ["http://panel.example.com", "https://panel.example.com/hls"]) {
    assert.throws(() => normalizeMediaAllowedOrigins([invalid]))
  }
})

test("requires an array with bounded, non-empty URL origins", () => {
  assert.deepEqual(normalizeMediaAllowedOrigins([]), [])
  assert.throws(() => normalizeMediaAllowedOrigins("https://panel.example.com"))
  assert.throws(() => normalizeMediaAllowedOrigins(null))
  assert.throws(() => normalizeMediaAllowedOrigins([""]))
  assert.throws(() => normalizeMediaAllowedOrigins(Array.from({ length: 21 }, (_, index) => `https://panel-${index}.example.com`)))
})

test("project origins are inherited as a de-duplicated union while manual bucket origins survive", () => {
  assert.deepEqual(
    mergeMediaAllowedOrigins(
      ["https://panel.example.com", "https://shared.example.com"],
      ["https://shared.example.com", "https://bucket.example.com"]
    ),
    ["https://panel.example.com", "https://shared.example.com", "https://bucket.example.com"]
  )
})

test("wildcard project or bucket origin dominates the effective union", () => {
  assert.deepEqual(mergeMediaAllowedOrigins(["https://panel.example.com"], ["*"]), ["*"])
  assert.deepEqual(mergeMediaAllowedOrigins(["*"], ["https://bucket.example.com"]), ["*"])
})

test("project bucket assignment payloads cannot mutate delivery policy", () => {
  assert.equal(hasProjectBucketDeliveryPolicyMutation({ bucketName: "media" }), false)
  assert.equal(hasProjectBucketDeliveryPolicyMutation({ bucketName: "media", makePrimary: true }), false)
  assert.equal(hasProjectBucketDeliveryPolicyMutation({ bucketName: "media", mediaAllowedOrigins: [] }), true)
  assert.equal(hasProjectBucketDeliveryPolicyMutation({ bucketName: "media", deliveryPublicAccessEnabled: false }), true)
})
