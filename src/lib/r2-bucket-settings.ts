import type { CORSRule } from "@aws-sdk/client-s3"

import type { CloudflareAccount } from "./accounts-store"
import { cloudflareFetchJson } from "./cloudflare-api"
import {
  r2DeleteBucketCors,
  r2GetBucketCors,
  r2PutBucketCors,
  type R2ClientConfig,
} from "./r2-s3"

export type BucketCorsRule = {
  id?: string
  allowedOrigins: string[]
  allowedMethods: string[]
  allowedHeaders: string[]
  exposeHeaders: string[]
  maxAgeSeconds?: number
}

export type ManagedPublicDomain = {
  enabled: boolean
  domain: string | null
  bucketId: string | null
}

export type BucketSettings = {
  publicAccess: ManagedPublicDomain
  corsRules: BucketCorsRule[]
}

export const MANAGED_MEDIA_CORS_RULE_ID = "drive-media-delivery"
// S3/R2 handles browser preflight automatically; OPTIONS is not a valid
// PutBucketCors AllowedMethod.
const MANAGED_MEDIA_CORS_METHODS = ["GET", "HEAD"]
const MANAGED_MEDIA_CORS_HEADERS = [
  "Range",
  "If-None-Match",
  "If-Modified-Since",
  "Content-Type",
  "Authorization",
  "X-Drive-API-Key",
  "X-Drive-Project",
  "X-Drive-Bucket",
]
const MANAGED_MEDIA_CORS_EXPOSED_HEADERS = ["Accept-Ranges", "Content-Length", "Content-Range", "Content-Type", "ETag", "Last-Modified"]

type CloudflareEnvelope<T> = {
  result?: T
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))
  )
}

export function normalizeCorsRules(value: unknown): BucketCorsRule[] {
  if (!Array.isArray(value)) throw new Error("CORS rules must be an array")
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) throw new Error(`CORS rule ${index + 1} is invalid`)
    const rule = raw as Record<string, unknown>
    const allowedOrigins = strings(rule.allowedOrigins ?? rule.AllowedOrigins)
    const allowedMethods = strings(rule.allowedMethods ?? rule.AllowedMethods).map((method) => method.toUpperCase())
    if (allowedOrigins.length === 0) throw new Error(`CORS rule ${index + 1} needs an allowed origin`)
    if (allowedMethods.length === 0) throw new Error(`CORS rule ${index + 1} needs an allowed method`)
    const maxAgeValue = rule.maxAgeSeconds ?? rule.MaxAgeSeconds
    const maxAgeSeconds = typeof maxAgeValue === "number" && Number.isFinite(maxAgeValue)
      ? Math.max(0, Math.floor(maxAgeValue))
      : undefined
    return {
      ...(typeof (rule.id ?? rule.ID) === "string" && String(rule.id ?? rule.ID).trim()
        ? { id: String(rule.id ?? rule.ID).trim() }
        : {}),
      allowedOrigins,
      allowedMethods,
      allowedHeaders: strings(rule.allowedHeaders ?? rule.AllowedHeaders),
      exposeHeaders: strings(rule.exposeHeaders ?? rule.ExposeHeaders),
      ...(maxAgeSeconds !== undefined ? { maxAgeSeconds } : {}),
    }
  })
}

function toAwsCorsRules(rules: BucketCorsRule[]): CORSRule[] {
  return rules.map((rule) => ({
    ...(rule.id ? { ID: rule.id } : {}),
    AllowedOrigins: rule.allowedOrigins,
    AllowedMethods: rule.allowedMethods,
    ...(rule.allowedHeaders.length ? { AllowedHeaders: rule.allowedHeaders } : {}),
    ...(rule.exposeHeaders.length ? { ExposeHeaders: rule.exposeHeaders } : {}),
    ...(rule.maxAgeSeconds !== undefined ? { MaxAgeSeconds: rule.maxAgeSeconds } : {}),
  }))
}

function fromAwsCorsRules(rules: CORSRule[]): BucketCorsRule[] {
  return normalizeCorsRules(rules)
}

export function mergeManagedMediaCorsRule(rules: BucketCorsRule[], origins: string[]) {
  const genericRules = rules.filter((rule) => rule.id !== MANAGED_MEDIA_CORS_RULE_ID)
  if (origins.length === 0) return genericRules
  return [
    ...genericRules,
    {
      id: MANAGED_MEDIA_CORS_RULE_ID,
      allowedOrigins: origins,
      allowedMethods: MANAGED_MEDIA_CORS_METHODS,
      allowedHeaders: MANAGED_MEDIA_CORS_HEADERS,
      exposeHeaders: MANAGED_MEDIA_CORS_EXPOSED_HEADERS,
      maxAgeSeconds: 86400,
    },
  ]
}

function corsRulesEqual(left: BucketCorsRule[], right: BucketCorsRule[]): boolean {
  const canonical = (rules: BucketCorsRule[]) => rules
    .map((rule) => ({
      id: rule.id ?? "",
      allowedOrigins: [...rule.allowedOrigins].sort(),
      allowedMethods: [...rule.allowedMethods].sort(),
      allowedHeaders: [...rule.allowedHeaders].sort(),
      exposeHeaders: [...rule.exposeHeaders].sort(),
      maxAgeSeconds: rule.maxAgeSeconds ?? null,
    }))
    .map((rule) => JSON.stringify(rule))
    .sort()
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function accountR2Config(account: CloudflareAccount): R2ClientConfig {
  if (!account.cloudflareAccountId || !account.r2AccessKeyId || !account.r2SecretAccessKey) {
    throw new Error(`Account ${account.label} is missing R2 credentials`)
  }
  return {
    accountId: account.cloudflareAccountId,
    accessKeyId: account.r2AccessKeyId,
    secretAccessKey: account.r2SecretAccessKey,
  }
}

function accountCloudflareConfig(account: CloudflareAccount) {
  if (!account.cloudflareAccountId || !account.apiToken) {
    throw new Error(`Account ${account.label} is missing Cloudflare API credentials`)
  }
  return { accountId: account.cloudflareAccountId, apiToken: account.apiToken }
}

export async function getManagedPublicDomain(
  account: CloudflareAccount,
  bucket: string
): Promise<ManagedPublicDomain> {
  const config = accountCloudflareConfig(account)
  const body = await cloudflareFetchJson<CloudflareEnvelope<Record<string, unknown>>>({
    apiToken: config.apiToken,
    path: `/accounts/${encodeURIComponent(config.accountId)}/r2/buckets/${encodeURIComponent(bucket)}/domains/managed`,
  })
  const result = body.result ?? {}
  return {
    enabled: result.enabled === true,
    domain: typeof result.domain === "string" && result.domain ? result.domain : null,
    bucketId: typeof result.bucketId === "string" && result.bucketId ? result.bucketId : null,
  }
}

export async function setManagedPublicDomain(
  account: CloudflareAccount,
  bucket: string,
  enabled: boolean
): Promise<ManagedPublicDomain> {
  const config = accountCloudflareConfig(account)
  await cloudflareFetchJson<CloudflareEnvelope<unknown>>({
    apiToken: config.apiToken,
    method: "PUT",
    path: `/accounts/${encodeURIComponent(config.accountId)}/r2/buckets/${encodeURIComponent(bucket)}/domains/managed`,
    body: { enabled },
  })
  const verified = await getManagedPublicDomain(account, bucket)
  if (verified.enabled !== enabled) throw new Error("Public development URL change could not be verified")
  return verified
}

export async function getBucketCors(account: CloudflareAccount, bucket: string): Promise<BucketCorsRule[]> {
  return fromAwsCorsRules(await r2GetBucketCors(accountR2Config(account), bucket))
}

async function writeBucketCors(account: CloudflareAccount, bucket: string, rules: BucketCorsRule[]) {
  if (rules.length === 0) {
    try {
      await r2DeleteBucketCors(accountR2Config(account), bucket)
    } catch (error: unknown) {
      const status =
        typeof error === "object" && error !== null && "$metadata" in error
          ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
          : undefined
      if (status !== 404) throw error
    }
  } else {
    await r2PutBucketCors(accountR2Config(account), bucket, toAwsCorsRules(rules))
  }
  const verified = await getBucketCors(account, bucket)
  if (!corsRulesEqual(verified, rules)) throw new Error("CORS changes could not be verified")
  return verified
}

export async function syncBucketDeliveryCorsRule(
  account: CloudflareAccount,
  bucket: string,
  origins: string[]
) {
  const current = await getBucketCors(account, bucket)
  return writeBucketCors(account, bucket, mergeManagedMediaCorsRule(current, origins))
}

export async function putBucketCors(
  account: CloudflareAccount,
  bucket: string,
  value: unknown
): Promise<BucketCorsRule[]> {
  const requested = normalizeCorsRules(value)
  const current = await getBucketCors(account, bucket)
  const managed = current.filter((rule) => rule.id === MANAGED_MEDIA_CORS_RULE_ID)
  return writeBucketCors(
    account,
    bucket,
    [...requested.filter((rule) => rule.id !== MANAGED_MEDIA_CORS_RULE_ID), ...managed]
  )
}

export async function deleteBucketCors(account: CloudflareAccount, bucket: string): Promise<void> {
  const current = await getBucketCors(account, bucket)
  await writeBucketCors(
    account,
    bucket,
    current.filter((rule) => rule.id === MANAGED_MEDIA_CORS_RULE_ID)
  )
}

export async function readBucketSettings(account: CloudflareAccount, bucket: string): Promise<BucketSettings> {
  const [publicAccess, corsRules] = await Promise.all([
    getManagedPublicDomain(account, bucket),
    getBucketCors(account, bucket),
  ])
  return { publicAccess, corsRules }
}

export async function syncBucketSettings(input: {
  source: CloudflareAccount
  target: CloudflareAccount
  sourceBucket: string
  targetBucket: string
}): Promise<{ source: BucketSettings; destination: BucketSettings }> {
  const sourceSettings = await readBucketSettings(input.source, input.sourceBucket)
  const currentTarget = await readBucketSettings(input.target, input.targetBucket)

  let destinationPublic = currentTarget.publicAccess
  let destinationCors = currentTarget.corsRules
  if (currentTarget.publicAccess.enabled !== sourceSettings.publicAccess.enabled) {
    destinationPublic = await setManagedPublicDomain(input.target, input.targetBucket, sourceSettings.publicAccess.enabled)
  }
  if (!corsRulesEqual(currentTarget.corsRules, sourceSettings.corsRules)) {
    destinationCors = await putBucketCors(input.target, input.targetBucket, sourceSettings.corsRules)
  }

  const verified = { publicAccess: destinationPublic, corsRules: destinationCors }
  if (verified.publicAccess.enabled !== sourceSettings.publicAccess.enabled) {
    throw new Error("Destination public development URL does not match the source")
  }
  if (!corsRulesEqual(verified.corsRules, sourceSettings.corsRules)) {
    throw new Error("Destination CORS rules do not match the source")
  }
  return { source: sourceSettings, destination: verified }
}
