import type { CloudflareAccount } from "./accounts-store"
import { allowedStorageCorsOrigins } from "./storage-delivery.cjs"
import {
  deleteBucketDeliverySettings,
  getBucketDeliverySettings,
  type BucketDeliverySettings,
  updateBucketDeliverySettings,
} from "./bucket-delivery-settings-store"
import { getProjectDeliverySettings } from "./project-delivery-settings-store"
import { getAssignedProjectIdForBucket, listProjectBuckets } from "./projects-store"
import { mergeMediaAllowedOrigins } from "./project-media-origins.cjs"
import { syncBucketDeliveryCorsRule } from "./r2-bucket-settings"

export async function getEffectiveBucketMediaOrigins(bucketName: string, settings: BucketDeliverySettings) {
  const projectId = await getAssignedProjectIdForBucket(bucketName)
  const inherited = projectId ? (await getProjectDeliverySettings(projectId)).mediaAllowedOrigins : null
  const manual = settings.mediaAllowedOrigins
  const effective = mergeMediaAllowedOrigins(inherited, manual)
  const effectiveMediaAllowedOrigins: string[] = inherited === null && manual === null
    ? allowedStorageCorsOrigins().filter((origin): origin is string => typeof origin === "string")
    : effective
  return {
    projectId,
    inheritedMediaAllowedOrigins: inherited,
    manualMediaAllowedOrigins: manual,
    effectiveMediaAllowedOrigins,
  }
}

async function restoreBucketDeliverySettings(
  before: BucketDeliverySettings,
  existed: boolean
) {
  if (!existed) {
    await deleteBucketDeliverySettings(before.accountId, before.bucketName)
    return
  }
  await updateBucketDeliverySettings({
    accountId: before.accountId,
    bucketName: before.bucketName,
    publicAccessEnabled: before.publicAccessEnabled,
    mediaAllowedOrigins: before.mediaAllowedOrigins,
  })
}

/**
 * Persists Drive delivery policy then synchronously merges/verifies its
 * dedicated R2 CORS rule. A failed R2 write restores the previous DB value.
 */
export async function updateAndSyncBucketDeliverySettings(input: {
  account: CloudflareAccount
  bucketName: string
  publicAccessEnabled?: boolean
  mediaAllowedOrigins?: unknown | null
}) {
  const before = await getBucketDeliverySettings(input.account.id, input.bucketName)
  const existed = Boolean(before.createdAt)
  const settings = await updateBucketDeliverySettings({
    accountId: input.account.id,
    bucketName: input.bucketName,
    ...(typeof input.publicAccessEnabled === "boolean"
      ? { publicAccessEnabled: input.publicAccessEnabled }
      : {}),
    ...(input.mediaAllowedOrigins !== undefined ? { mediaAllowedOrigins: input.mediaAllowedOrigins } : {}),
  })

  if (input.mediaAllowedOrigins === undefined) return settings
  try {
    const effective = await getEffectiveBucketMediaOrigins(input.bucketName, settings)
    await syncBucketDeliveryCorsRule(input.account, input.bucketName, effective.effectiveMediaAllowedOrigins)
    return settings
  } catch (error) {
    await restoreBucketDeliverySettings(before, existed).catch((rollbackError) => {
      console.error("Unable to roll back bucket delivery settings after CORS sync failure:", rollbackError)
    })
    const restored = await getBucketDeliverySettings(input.account.id, input.bucketName).catch(() => before)
    const restoredEffective = await getEffectiveBucketMediaOrigins(input.bucketName, restored).catch(() => null)
    if (restoredEffective) {
      await syncBucketDeliveryCorsRule(
        input.account,
        input.bucketName,
        restoredEffective.effectiveMediaAllowedOrigins
      ).catch((rollbackError) => {
        console.error("Unable to restore bucket CORS after delivery settings rollback:", rollbackError)
      })
    }
    throw error
  }
}

export async function syncEffectiveBucketDeliveryCors(input: {
  account: CloudflareAccount
  bucketName: string
}) {
  const settings = await getBucketDeliverySettings(input.account.id, input.bucketName)
  const effective = await getEffectiveBucketMediaOrigins(input.bucketName, settings)
  await syncBucketDeliveryCorsRule(input.account, input.bucketName, effective.effectiveMediaAllowedOrigins)
  return { settings, ...effective }
}

export async function syncProjectDeliveryCors(input: {
  account: CloudflareAccount
  projectIdentifier: string
}) {
  const buckets = await listProjectBuckets(input.projectIdentifier)
  const results = []
  for (const bucket of buckets) {
    results.push(await syncEffectiveBucketDeliveryCors({ account: input.account, bucketName: bucket.bucketName }))
  }
  return results
}
