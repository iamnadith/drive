import { NextResponse } from "next/server"
import { getActiveAccount, type CloudflareAccount } from "./accounts-store"
import {
  authorizeProjectApiKey,
  listProjectBuckets,
  validateProjectApiKey,
  type Project,
  type ProjectPermission,
} from "./projects-store"
import { r2HeadBucket, type R2ClientConfig } from "./r2-s3"

declare global {
  var __driveProjectActiveAccountCache:
    | { expiresAt: number; account: CloudflareAccount | null }
    | undefined
  var __driveProjectBucketAssignmentCache:
    | Map<string, { expiresAt: number; bucketNames: string[] }>
    | undefined
  var __driveProjectBucketAvailabilityCache:
    | Map<string, { expiresAt: number; ok: boolean }>
    | undefined
  var __driveProjectRateLimitCache:
    | Map<string, { windowStartedAt: number; count: number }>
    | undefined
}

export function getProjectApiKeyFromRequest(request: Request) {
  const authorization = request.headers.get("authorization") ?? ""
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  return bearer || request.headers.get("x-drive-api-key")?.trim() || ""
}

export function projectIdFromUrl(request: Request) {
  const url = new URL(request.url)
  return (
    url.searchParams.get("projectId")?.trim() ||
    request.headers.get("x-drive-project")?.trim() ||
    ""
  )
}

export function projectBucketFromRequest(request: Request) {
  const url = new URL(request.url)
  return url.searchParams.get("bucket")?.trim() || request.headers.get("x-drive-bucket")?.trim() || ""
}

export async function authorizeProjectRequest(
  request: Request,
  projectId: string,
  permission: ProjectPermission
) {
  const apiKey = getProjectApiKeyFromRequest(request)
  if (!apiKey) return { response: NextResponse.json({ error: "Missing API key" }, { status: 401 }) }
  if (!projectId) return { response: NextResponse.json({ error: "Project ID is required" }, { status: 400 }) }

  const auth = await authorizeProjectApiKey(apiKey, projectId, permission)
  if ("error" in auth) {
    return { response: NextResponse.json({ error: auth.error }, { status: auth.status }) }
  }
  const limited = enforceProjectRateLimit(request, auth.apiKey.id, projectId)
  if (limited) return { response: limited }
  return { auth }
}

export async function validateProjectListRequest(request: Request) {
  const apiKey = getProjectApiKeyFromRequest(request)
  if (!apiKey) return { response: NextResponse.json({ error: "Missing API key" }, { status: 401 }) }
  const auth = await validateProjectApiKey(apiKey)
  if (!auth) return { response: NextResponse.json({ error: "Invalid API key" }, { status: 401 }) }
  const limited = enforceProjectRateLimit(request, auth.apiKey.id, "projects")
  if (limited) return { response: limited }
  return { auth }
}

function cacheTtlMs(envName: string, fallbackSeconds: number) {
  const parsed = Number(process.env[envName] ?? fallbackSeconds)
  return Math.max(5, Math.min(300, Number.isFinite(parsed) ? parsed : fallbackSeconds)) * 1000
}

async function getCachedActiveAccount() {
  const cached = global.__driveProjectActiveAccountCache
  if (cached && cached.expiresAt > Date.now()) return cached.account
  const account = await getActiveAccount()
  global.__driveProjectActiveAccountCache = {
    account,
    expiresAt: Date.now() + cacheTtlMs("PROJECT_ACTIVE_ACCOUNT_CACHE_TTL_SECONDS", 30),
  }
  return account
}

function getBucketCache() {
  if (!global.__driveProjectBucketAvailabilityCache) {
    global.__driveProjectBucketAvailabilityCache = new Map()
  }
  return global.__driveProjectBucketAvailabilityCache
}

function getProjectBucketAssignmentCache() {
  if (!global.__driveProjectBucketAssignmentCache) {
    global.__driveProjectBucketAssignmentCache = new Map()
  }
  return global.__driveProjectBucketAssignmentCache
}

function getRateLimitCache() {
  if (!global.__driveProjectRateLimitCache) {
    global.__driveProjectRateLimitCache = new Map()
  }
  return global.__driveProjectRateLimitCache
}

function clientIp(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  )
}

function enforceProjectRateLimit(request: Request, apiKeyId: string, projectId: string) {
  const parsedLimit = Number(process.env.PROJECT_API_RATE_LIMIT_PER_MINUTE ?? 3000)
  const limit = Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 3000)
  const windowMs = 60_000
  const key = `${apiKeyId}:${projectId}:${clientIp(request)}`
  const cache = getRateLimitCache()
  const current = cache.get(key)
  const now = Date.now()
  if (!current || now - current.windowStartedAt >= windowMs) {
    cache.set(key, { windowStartedAt: now, count: 1 })
    return null
  }
  current.count += 1
  if (current.count <= limit) return null
  const retryAfter = Math.ceil((windowMs - (now - current.windowStartedAt)) / 1000)
  return NextResponse.json(
    { error: "Rate limit exceeded", retryAfterSeconds: retryAfter },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfter) },
    }
  )
}

export async function getActiveProjectR2Config(project: Project): Promise<
  | { config: R2ClientConfig; bucketName: string }
  | { response: NextResponse<{ error: string }> }
> {
  return getActiveProjectBucketR2Config(project, undefined)
}

export async function resolveProjectBucketName(
  project: Project,
  requestedBucketName?: string
): Promise<{ bucketName: string } | { response: NextResponse<{ error: string }> }> {
  const selectedBucketName = requestedBucketName?.trim() || project.bucketName

  if (!selectedBucketName) {
    return {
      response: NextResponse.json(
        { error: "Project does not have a primary bucket assigned yet" },
        { status: 409 }
      ),
    }
  }

  if (selectedBucketName === project.bucketName) {
    return { bucketName: selectedBucketName }
  }

  const cache = getProjectBucketAssignmentCache()
  const cacheKey = project.id
  const cached = cache.get(cacheKey)
  const bucketNames = cached && cached.expiresAt > Date.now()
    ? cached.bucketNames
    : await listProjectBuckets(project.id).then(assignments => {
      const nextBucketNames = assignments.map(bucket => bucket.bucketName)
      cache.set(cacheKey, {
        bucketNames: nextBucketNames,
        expiresAt: Date.now() + cacheTtlMs("PROJECT_BUCKET_ASSIGNMENT_CACHE_TTL_SECONDS", 60),
      })
      return nextBucketNames
    })
  const isAssigned = bucketNames.some((bucketName) => bucketName === selectedBucketName)
  if (!isAssigned) {
    return {
      response: NextResponse.json(
        { error: "Requested bucket is not assigned to this project" },
        { status: 403 }
      ),
    }
  }

  return { bucketName: selectedBucketName }
}

export async function getActiveProjectBucketR2Config(
  project: Project,
  requestedBucketName?: string
): Promise<
  | { config: R2ClientConfig; bucketName: string }
  | { response: NextResponse<{ error: string }> }
> {
  const resolved = await resolveProjectBucketName(project, requestedBucketName)
  if ("response" in resolved) return resolved
  const selectedBucketName = resolved.bucketName

  const active = await getCachedActiveAccount()
  if (
    !active?.cloudflareAccountId ||
    !active.r2AccessKeyId ||
    !active.r2SecretAccessKey
  ) {
    return {
      response: NextResponse.json(
        { error: "Active Cloudflare account is missing R2 credentials" },
        { status: 409 }
      ),
    }
  }

  const config = {
    accountId: active.cloudflareAccountId,
    accessKeyId: active.r2AccessKeyId,
    secretAccessKey: active.r2SecretAccessKey,
  }

  const bucketCache = getBucketCache()
  const bucketCacheKey = `${active.id}:${active.cloudflareAccountId}:${selectedBucketName}`
  const cached = bucketCache.get(bucketCacheKey)
  if (!cached || cached.expiresAt <= Date.now()) {
    try {
      await r2HeadBucket(config, selectedBucketName)
      bucketCache.set(bucketCacheKey, {
        ok: true,
        expiresAt: Date.now() + cacheTtlMs("PROJECT_BUCKET_CACHE_TTL_SECONDS", 120),
      })
    } catch {
      bucketCache.set(bucketCacheKey, {
        ok: false,
        expiresAt: Date.now() + cacheTtlMs("PROJECT_BUCKET_NEGATIVE_CACHE_TTL_SECONDS", 30),
      })
    }
  }

  const bucketAvailable = bucketCache.get(bucketCacheKey)?.ok === true
  if (!bucketAvailable) {
    return {
      response: NextResponse.json(
        {
          error:
            "Requested project bucket is not available in the current active Cloudflare account",
        },
        { status: 409 }
      ),
    }
  }

  return { config, bucketName: selectedBucketName }
}
