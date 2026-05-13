export function normalizeProjectBucketName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "")
}

export function resolveProjectBucketCandidate(input: {
  rawBucketName: string
  fallbackProjectName: string
}) {
  return normalizeProjectBucketName(input.rawBucketName || input.fallbackProjectName)
}

export function validateProjectBucketCandidate(input: {
  mode: "create" | "link"
  rawBucketName: string
  fallbackProjectName: string
  availableBucketNames: string[]
  assignedBucketNames: string[]
}) {
  const bucketName = resolveProjectBucketCandidate({
    rawBucketName: input.rawBucketName,
    fallbackProjectName: input.fallbackProjectName,
  })

  if (!bucketName) return { bucketName, error: "Bucket name is required" }

  if (input.assignedBucketNames.includes(bucketName)) {
    return { bucketName, error: "That bucket is already assigned to this project" }
  }

  if (input.mode === "create" && input.availableBucketNames.includes(bucketName)) {
    return { bucketName, error: "Bucket name already exists" }
  }

  if (input.mode === "link" && !input.availableBucketNames.includes(bucketName)) {
    return { bucketName, error: "Bucket name does not exist in the active account" }
  }

  return { bucketName, error: null }
}
