import { NextResponse } from "next/server"

import { getActiveAccount } from "./accounts-store"
import { getBucketDeliverySettings } from "./bucket-delivery-settings-store"
import { getEffectiveBucketMediaOrigins } from "./bucket-delivery-settings-service"
import {
  createStorageDeliveryHeaders,
  isStorageDeliveryOriginAllowed,
} from "./storage-delivery.cjs"

/**
 * Browser origins are an authorization boundary for file delivery. API keys
 * authenticate a project but cannot override an explicit origin policy.
 * Requests without Origin are server-to-server and remain API-authenticated by
 * the calling route.
 */
export async function rejectDisallowedBucketDeliveryOrigin(
  request: Request,
  bucketName: string
) {
  const origin = request.headers.get("origin")
  if (!origin) return null
  const account = await getActiveAccount()
  if (!account) {
    return NextResponse.json({ error: "No active Cloudflare account is configured" }, { status: 409 })
  }
  const settings = await getBucketDeliverySettings(account.id, bucketName)
  const effective = await getEffectiveBucketMediaOrigins(bucketName, settings)
  const configuredOrigins = effective.effectiveMediaAllowedOrigins.join(",")
  if (isStorageDeliveryOriginAllowed(origin, configuredOrigins)) return null

  const response = NextResponse.json(
    { error: "Request origin is not allowed for this bucket" },
    { status: 403 }
  )
  createStorageDeliveryHeaders(origin, configuredOrigins).forEach((value, name) => {
    response.headers.set(name, value)
  })
  return response
}
