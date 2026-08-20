const assert = require("node:assert/strict")
const test = require("node:test")
const { assertExactBucketConfirmation } = require("../src/lib/bucket-danger-confirmation.cjs")

test("bucket danger actions require exact confirmation", () => {
  assert.doesNotThrow(() => assertExactBucketConfirmation("media-prod", "media-prod"))
  assert.throws(() => assertExactBucketConfirmation("media-prod", "MEDIA-PROD"), /exact bucket name/)
  assert.throws(() => assertExactBucketConfirmation("media-prod", "yes"), /exact bucket name/)
})
