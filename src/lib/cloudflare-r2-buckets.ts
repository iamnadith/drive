import { cloudflareFetchJson } from "./cloudflare-api"

export type R2BucketJurisdiction = "default" | "eu" | "fedramp"
export type R2BucketStorageClass = "Standard" | "InfrequentAccess"

export type CloudflareApiEnvelope<T> = {
  success?: boolean
  errors?: Array<{ code?: number; message?: string }>
  messages?: string[]
  result?: T
}

export type R2Bucket = {
  name: string
  creation_date?: string
  location?: string
  jurisdiction?: R2BucketJurisdiction
  storage_class?: R2BucketStorageClass
  object_count?: number
  objects?: number
  size?: number
  size_bytes?: number
}

export async function r2ListBuckets(input: {
  accountId: string
  apiToken: string
}): Promise<R2Bucket[]> {
  const body = await cloudflareFetchJson<CloudflareApiEnvelope<unknown>>({
    apiToken: input.apiToken,
    path: `/accounts/${encodeURIComponent(input.accountId)}/r2/buckets`,
  })

  const result = body?.result
  const bucketsArray = (() => {
    if (typeof result !== "object" || result === null) return []
    const maybe = result as { buckets?: unknown }
    if (Array.isArray(maybe.buckets)) return maybe.buckets
    if (Array.isArray(result)) return result
    return []
  })()

  return bucketsArray
    .map((bucket) => {
      const maybe = bucket as Record<string, unknown>
      return {
        name: String(maybe?.name ?? ""),
      creation_date:
        typeof maybe?.creation_date === "string"
          ? String(maybe.creation_date)
          : undefined,
      location: typeof maybe?.location === "string" ? String(maybe.location) : undefined,
      jurisdiction:
        maybe?.jurisdiction === "default" ||
        maybe?.jurisdiction === "eu" ||
        maybe?.jurisdiction === "fedramp"
          ? (maybe.jurisdiction as R2BucketJurisdiction)
          : undefined,
      storage_class:
        maybe?.storage_class === "Standard" || maybe?.storage_class === "InfrequentAccess"
          ? (maybe.storage_class as R2BucketStorageClass)
          : undefined,
      objects:
        typeof maybe?.objects === "number"
          ? (maybe.objects as number)
          : typeof maybe?.object_count === "number"
            ? (maybe.object_count as number)
            : undefined,
      size:
        typeof maybe?.size === "number"
          ? (maybe.size as number)
          : typeof maybe?.size_bytes === "number"
            ? (maybe.size_bytes as number)
            : undefined,
      }
    })
    .filter((bucket) => bucket.name.length > 0)
}

export async function r2CreateBucketViaApi(input: {
  accountId: string
  apiToken: string
  name: string
  locationHint?: string
  jurisdiction?: R2BucketJurisdiction
  storageClass?: R2BucketStorageClass
}) {
  return cloudflareFetchJson<CloudflareApiEnvelope<unknown>>({
    apiToken: input.apiToken,
    method: "POST",
    path: `/accounts/${encodeURIComponent(input.accountId)}/r2/buckets`,
    body: {
      name: input.name,
      ...(input.locationHint ? { locationHint: input.locationHint } : {}),
      ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}),
      ...(input.storageClass ? { storageClass: input.storageClass } : {}),
    },
  })
}
