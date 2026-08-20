import type { CloudflareAccount } from "./accounts-store"
import { deleteBucketDeliverySettings } from "./bucket-delivery-settings-store"
import { listProjectsUsingBucket, removeProjectBucket } from "./projects-store"
import { assertProjectBucketHasNoActiveLocks } from "./project-operations-store"
import { markTrackedBucketPrefixDeleted } from "./project-operations-store"
import { assertExactBucketConfirmation } from "./bucket-danger-confirmation.cjs"
import { r2DeleteAllBucketContents, r2DeleteBucket, r2ListAllMultipartUploads, r2ListAllObjectVersions, r2ListAllObjects, type R2ClientConfig } from "./r2-s3"

export type BucketDangerAction = "clear" | "delete"
export type BucketDangerResult = {
  action: BucketDangerAction
  bucketName: string
  deletedObjects: number
  deletedVersions: number
  abortedMultipartUploads: number
  removedProjectAssignments: number
}

export async function runBucketDangerAction(input: {
  account: CloudflareAccount
  bucketName: string
  action: BucketDangerAction
  confirmation: unknown
}): Promise<BucketDangerResult> {
  const bucketName = input.bucketName.trim()
  if (!bucketName) throw new Error("Bucket name is required")
  if (input.action !== "clear" && input.action !== "delete") throw new Error("Unsupported bucket danger action")
  assertExactBucketConfirmation(bucketName, input.confirmation)
  if (!input.account.cloudflareAccountId || !input.account.r2AccessKeyId || !input.account.r2SecretAccessKey) throw new Error("Account is missing R2 credentials")
  const config: R2ClientConfig = { accountId: input.account.cloudflareAccountId, accessKeyId: input.account.r2AccessKeyId, secretAccessKey: input.account.r2SecretAccessKey }
  const assignedProjects = await listProjectsUsingBucket(bucketName)
  for (const project of assignedProjects) await assertProjectBucketHasNoActiveLocks(project.id, bucketName)
  const cleared = await r2DeleteAllBucketContents(config, bucketName)
  await Promise.all(assignedProjects.map((project) => markTrackedBucketPrefixDeleted({ projectId: project.id, bucketName, prefix: "" }).catch(() => undefined)))
  const [remainingObjects, remainingUploads, remainingVersions] = await Promise.all([
    r2ListAllObjects(config, bucketName, { maxObjects: 1 }),
    r2ListAllMultipartUploads(config, bucketName, 1),
    r2ListAllObjectVersions(config, bucketName, 1).catch(() => []),
  ])
  if (remainingObjects.length || remainingUploads.length || remainingVersions.length) throw new Error("Bucket is not empty after cleanup; deletion was not attempted")
  let removedProjectAssignments = 0
  if (input.action === "delete") {
    await r2DeleteBucket(config, bucketName)
    for (const project of assignedProjects) {
      await removeProjectBucket(project.id, bucketName)
      removedProjectAssignments += 1
    }
    await deleteBucketDeliverySettings(input.account.id, bucketName)
  }
  return { action: input.action, bucketName, deletedObjects: cleared.objects, deletedVersions: cleared.versions, abortedMultipartUploads: cleared.multipart, removedProjectAssignments }
}
