function assertExactBucketConfirmation(bucketName, confirmation) {
  if (typeof confirmation !== "string" || confirmation !== bucketName) {
    throw new Error("Type the exact bucket name to confirm this destructive action")
  }
}

module.exports = { assertExactBucketConfirmation }
