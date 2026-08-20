import type { CloudflareAccount } from "./accounts-store"
import { allowedStorageCorsOrigins } from "./storage-delivery.cjs"
import {
  deleteBucketDeliverySettings,
  getBucketDeliverySettings,
  type BucketDeliverySettings,
  updateBucketDeliverySettings,
} from "./bucket-delivery-settings-store"
import { syncBucketDeliveryCorsRule } from "./r2-bucket-settings"

function effectiveMediaOrigins(settings: BucketDeliverySettings) {
  return (settings.mediaAllowedOrigins ?? allowedStorageCorsOrigins())
    .filter((origin): origin is string => typeof origin === "string")
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
    await syncBucketDeliveryCorsRule(input.account, input.bucketName, effectiveMediaOrigins(settings))
    return settings
  } catch (error) {
    await restoreBucketDeliverySettings(before, existed).catch((rollbackError) => {
      console.error("Unable to roll back bucket delivery settings after CORS sync failure:", rollbackError)
    })
    throw error
  }
}
