import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { r2CreateBucketViaApi, r2ListBuckets } from "@/lib/cloudflare-r2-buckets"
import {
  slurperConnectivityPrecheckSource,
  slurperConnectivityPrecheckTarget,
  slurperCreateJob,
  slurperGetActiveJobCount,
  slurperExtractCreatedJobId,
  slurperFindJobIdForBuckets,
  type SlurperJurisdiction,
  type SlurperSource,
} from "@/lib/cloudflare-r2-super-slurper"
import { cloudflareFetchJson, CloudflareApiError } from "@/lib/cloudflare-api"
import { r2ListOneObject } from "@/lib/r2-s3"
import {
  getMigration,
  listMigrationItems,
  updateMigration,
  updateMigrationItem,
  claimMigrationItemJobCreation,
} from "@/lib/migrations-store"

export const runtime = "nodejs"

const MAX_CLOUDFLARE_CONCURRENT_JOBS = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function formatCloudflareError(error: unknown, fallback: string): string {
  if (error instanceof CloudflareApiError) {
    const status = typeof error.status === "number" ? ` (HTTP ${error.status})` : ""
    const raw = typeof error.payloadText === "string" ? error.payloadText.trim() : ""
    const snippet = raw ? ` - ${raw.slice(0, 280)}` : ""
    return `${error.message}${status}${snippet}`
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message
  }
  return fallback
}

function isRateLimited(error: unknown): error is CloudflareApiError {
  return error instanceof CloudflareApiError && error.status === 429
}

function isJobLimitReached(error: unknown): error is CloudflareApiError {
  return error instanceof CloudflareApiError && error.status === 409
}

async function promisePool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
) {
  const limit = Math.max(1, Math.min(10, Math.floor(concurrency || 1)))
  let index = 0

  const run = async () => {
    while (true) {
      const current = index++
      if (current >= items.length) return
      await worker(items[current])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
}

function mapToJurisdiction(value: unknown): SlurperJurisdiction | undefined {
  if (value === "default" || value === "eu" || value === "fedramp") return value
  return undefined
}

function buildSourceSpec(input: {
  bucket: string
  sourceAccountId: string
  accessKeyId: string
  secretAccessKey: string
  pathPrefix?: string | null
}): SlurperSource {
  // Primary mode: S3-compatible source using the R2 endpoint (Cloudflare's recommended UI path).
  return {
    vendor: "s3",
    bucket: input.bucket,
    secret: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    // Cloudflare's Super Slurper expects the bucket in the endpoint for R2 S3 sources.
    endpoint: `https://${input.sourceAccountId}.r2.cloudflarestorage.com/${encodeURIComponent(input.bucket)}`,
    ...(typeof input.pathPrefix !== "undefined" ? { pathPrefix: input.pathPrefix } : {}),
  }
}

function buildSourceSpecR2Fallback(input: {
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  jurisdiction?: SlurperJurisdiction
  pathPrefix?: string | null
}): SlurperSource {
  // Fallback: R2-native source (kept internal, no UI toggle). Some accounts/credentials
  // can pass this precheck even when S3-compatible precheck fails.
  return {
    vendor: "r2",
    bucket: input.bucket,
    secret: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    jurisdiction: input.jurisdiction,
    ...(typeof input.pathPrefix !== "undefined" ? { pathPrefix: input.pathPrefix } : {}),
  }
}

function formatAwsError(error: unknown): string {
  if (typeof error !== "object" || error === null) return "Unknown S3 error"
  const maybe = error as { name?: unknown; message?: unknown; Code?: unknown; code?: unknown }
  const code = typeof maybe.Code === "string" ? maybe.Code : typeof maybe.code === "string" ? maybe.code : ""
  const name = typeof maybe.name === "string" ? maybe.name : ""
  const message = typeof maybe.message === "string" ? maybe.message : ""
  const parts = [code || name, message].filter((p) => p && String(p).trim())
  return parts.length ? parts.join(": ") : "Unknown S3 error"
}

async function checkDestinationSlurperPermissions(input: { accountId: string; apiToken: string }): Promise<string | null> {
  try {
    await cloudflareFetchJson(
      {
        apiToken: input.apiToken,
        path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/jobs`,
      },
      { retries: 0, timeoutMs: 10_000 }
    )
    return null
  } catch (error: unknown) {
    if (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403)) {
      return `Destination API token cannot access Super Slurper endpoints (HTTP ${error.status}). Ensure the token has R2 permissions (including Super Slurper).`
    }
    return null
  }
}

async function ensureTargetBucketExists(input: {
  targetCloudflareAccountId: string
  targetApiToken: string
  bucketName: string
  jurisdiction?: SlurperJurisdiction
  storageClass?: "Standard" | "InfrequentAccess"
}) {
  try {
    await r2CreateBucketViaApi({
      accountId: input.targetCloudflareAccountId,
      apiToken: input.targetApiToken,
      name: input.bucketName,
      jurisdiction: input.jurisdiction,
      storageClass: input.storageClass,
    })
  } catch (error: unknown) {
    if (error instanceof CloudflareApiError) {
      const text = (error.payloadText ?? "").toLowerCase()
      const msg = (error.message ?? "").toLowerCase()
      const alreadyExists =
        msg.includes("already") ||
        msg.includes("exists") ||
        text.includes("already") ||
        text.includes("exists")
      if (alreadyExists) return
    }
    throw error
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    const migration = await getMigration(id)
    if (!migration) {
      return NextResponse.json({ error: "Migration not found" }, { status: 404 })
    }

    const items = await listMigrationItems(id)
    if (items.length === 0) {
      return NextResponse.json(
        { error: "Migration has no buckets to migrate" },
        { status: 400 }
      )
    }

    const accounts = await getAllAccounts()
    const source = accounts.find((a) => a.id === migration.sourceAccountId)
    const target = accounts.find((a) => a.id === migration.targetAccountId)
    if (!source) return NextResponse.json({ error: "Source account not found" }, { status: 400 })
    if (!target) return NextResponse.json({ error: "Target account not found" }, { status: 400 })

    if (!source.cloudflareAccountId) {
      return NextResponse.json({ error: "Source Cloudflare account is not synced" }, { status: 400 })
    }
    if (!target.cloudflareAccountId) {
      return NextResponse.json({ error: "Target Cloudflare account is not synced" }, { status: 400 })
    }

    if (!source.r2AccessKeyId || !source.r2SecretAccessKey) {
      return NextResponse.json({ error: "Source account missing R2 access keys" }, { status: 400 })
    }
    if (!target.r2AccessKeyId || !target.r2SecretAccessKey) {
      return NextResponse.json({ error: "Target account missing R2 access keys" }, { status: 400 })
    }

    const url = new URL(request.url)
    const asyncStart = url.searchParams.get("async") === "1"

    const startedAt = migration.startedAt ?? new Date().toISOString()
    await updateMigration(id, {
      status: "running",
      startedAt,
      syncStatus: "syncing",
      syncMessage: asyncStart ? "Queued migration (sync will start jobs)" : "Creating buckets and Super Slurper jobs",
      lastSyncedAt: new Date().toISOString(),
    })

    if (asyncStart) {
      // Mark items queued and return immediately; the sync endpoint drives job/copy creation.
      await promisePool(items, migration.options.concurrency ?? 3, async (item) => {
        if (item.slurperStatus) return
        await updateMigrationItem(item.id, {
          slurperStatus: "queued",
          progress: { ...(item.progress ?? {}), stage: "queued" },
          lastProgressAt: new Date().toISOString(),
        })
      })

      const refreshedItems = await listMigrationItems(id)
      await updateMigration(id, {
        syncStatus: "ok",
        syncMessage: "Queued migration",
        lastSyncedAt: new Date().toISOString(),
      })

      return NextResponse.json({ migration: await getMigration(id), items: refreshedItems }, { status: 200 })
    }

    const targetBuckets = await r2ListBuckets({
      accountId: target.cloudflareAccountId,
      apiToken: target.apiToken,
    })
    const targetBucketSet = new Set(targetBuckets.map((b) => b.name))

    const createBucketItems = items.filter((item) => !targetBucketSet.has(item.targetBucket))
    await promisePool(createBucketItems, migration.options.concurrency ?? 3, async (item) => {
      try {
        await ensureTargetBucketExists({
          targetCloudflareAccountId: target.cloudflareAccountId!,
          targetApiToken: target.apiToken,
          bucketName: item.targetBucket,
          jurisdiction: mapToJurisdiction(item.sourceJurisdiction),
          storageClass:
            item.sourceStorageClass === "Standard" || item.sourceStorageClass === "InfrequentAccess"
              ? item.sourceStorageClass
              : undefined,
        })
        targetBucketSet.add(item.targetBucket)
      } catch (error: unknown) {
        const message = formatCloudflareError(error, "Unable to create target bucket")
        await updateMigrationItem(item.id, {
          slurperStatus: "bucket_create_failed",
          progress: {
            ...(item.progress ?? {}),
            error: message,
            stage: "create_target_bucket",
          },
          lastProgressAt: new Date().toISOString(),
        })
      }
    })

    const refreshedAfterBuckets = await listMigrationItems(id)

    const itemsNeedingJobs = refreshedAfterBuckets.filter(
      (item) =>
        !item.slurperJobId &&
        targetBucketSet.has(item.targetBucket) &&
        item.slurperStatus !== "bucket_create_failed" &&
        !String(item.slurperStatus ?? "").toLowerCase().startsWith("copy_")
    )
    const overwrite = migration.options.overwrite ?? true
    const pathPrefix = migration.options.pathPrefix
    const maxConcurrent = Math.max(
      1,
      Math.min(MAX_CLOUDFLARE_CONCURRENT_JOBS, Math.floor(migration.options.concurrency ?? 3))
    )

    const remoteActive = await slurperGetActiveJobCount({
      accountId: target.cloudflareAccountId!,
      apiToken: target.apiToken,
    }).catch(() => 0)
    const availableSlots = Math.max(0, maxConcurrent - remoteActive)

    await promisePool(itemsNeedingJobs, maxConcurrent, async (item) => {
      if (!item.slurperStatus) {
        await updateMigrationItem(item.id, {
          slurperStatus: "queued",
          progress: { ...(item.progress ?? {}), stage: "queued" },
          lastProgressAt: new Date().toISOString(),
        })
      }
    })

    const toStart = itemsNeedingJobs.slice(0, availableSlots)

    await promisePool(toStart, 1, async (item) => {
      try {
        try {
          await ensureTargetBucketExists({
            targetCloudflareAccountId: target.cloudflareAccountId!,
            targetApiToken: target.apiToken,
            bucketName: item.targetBucket,
            jurisdiction: mapToJurisdiction(item.sourceJurisdiction),
            storageClass:
              item.sourceStorageClass === "Standard" || item.sourceStorageClass === "InfrequentAccess"
                ? item.sourceStorageClass
                : undefined,
          })
        } catch (error: unknown) {
          if (isRateLimited(error)) {
            const delay = typeof error.retryAfterMs === "number" ? error.retryAfterMs : 5_000
            const message = `${formatCloudflareError(error, "Cloudflare rate limited bucket creation")} (retry in ~${Math.ceil(delay / 1000)}s)`
            await updateMigrationItem(item.id, {
              slurperStatus: "queued",
              progress: { ...(item.progress ?? {}), stage: "rate_limited_bucket_create", error: message },
              lastProgressAt: new Date().toISOString(),
            })
            return
          }
          throw error
        }

        const sourceSpecS3 = buildSourceSpec({
          bucket: item.sourceBucket,
          sourceAccountId: source.cloudflareAccountId!,
          accessKeyId: source.r2AccessKeyId!,
          secretAccessKey: source.r2SecretAccessKey!,
          pathPrefix: typeof pathPrefix !== "undefined" ? pathPrefix : undefined,
        })
        const sourceSpecR2 = buildSourceSpecR2Fallback({
          bucket: item.sourceBucket,
          accessKeyId: source.r2AccessKeyId!,
          secretAccessKey: source.r2SecretAccessKey!,
          jurisdiction: mapToJurisdiction(item.sourceJurisdiction),
          pathPrefix: typeof pathPrefix !== "undefined" ? pathPrefix : undefined,
        })

        // Connectivity prechecks make Cloudflare-side failures actionable before job creation.
        try {
          await slurperConnectivityPrecheckTarget({
            accountId: target.cloudflareAccountId!,
            apiToken: target.apiToken,
            body: {
              vendor: "r2",
              bucket: item.targetBucket,
              secret: {
                accessKeyId: target.r2AccessKeyId!,
                secretAccessKey: target.r2SecretAccessKey!,
              },
              jurisdiction: mapToJurisdiction(item.sourceJurisdiction),
            },
          })
        } catch (error: unknown) {
          const message = formatCloudflareError(error, "Target preconnectivity failed")
          await updateMigrationItem(item.id, {
            slurperStatus: "precheck_failed",
            progress: { ...(item.progress ?? {}), stage: "precheck_target", error: message },
            lastProgressAt: new Date().toISOString(),
          })
          return
        }

        let effectiveSource: SlurperSource = sourceSpecS3
        let s3Error = ""
        try {
          await slurperConnectivityPrecheckSource({
            accountId: target.cloudflareAccountId!,
            apiToken: target.apiToken,
            body: sourceSpecS3,
          })
        } catch (error2: unknown) {
          s3Error = formatCloudflareError(error2, "Source preconnectivity failed")
          try {
            await slurperConnectivityPrecheckSource({
              accountId: target.cloudflareAccountId!,
              apiToken: target.apiToken,
              body: sourceSpecR2,
            })
            effectiveSource = sourceSpecR2
          } catch (error3: unknown) {
            let message = s3Error
            const r2Message = formatCloudflareError(error3, "Source preconnectivity failed (r2)")
            message = `${message} | r2 fallback: ${r2Message}`

            if (isRateLimited(error2) || isRateLimited(error3)) {
              const chosen = (isRateLimited(error2) ? error2 : error3) as CloudflareApiError
              const delay = typeof chosen.retryAfterMs === "number" ? chosen.retryAfterMs : 5_000
              message = `${message} | Cloudflare rate limited precheck (retry in ~${Math.ceil(delay / 1000)}s)`
              await updateMigrationItem(item.id, {
                slurperStatus: "queued",
                progress: { ...(item.progress ?? {}), stage: "rate_limited_precheck", error: message },
                lastProgressAt: new Date().toISOString(),
              })
              return
            }

            const destPermHint = await checkDestinationSlurperPermissions({
              accountId: target.cloudflareAccountId!,
              apiToken: target.apiToken,
            })
            if (destPermHint) message = `${message} | ${destPermHint}`

            // Sanity check: can these keys read the source bucket from this server?
            try {
              await r2ListOneObject(
                {
                  accountId: source.cloudflareAccountId!,
                  accessKeyId: source.r2AccessKeyId!,
                  secretAccessKey: source.r2SecretAccessKey!,
                },
                item.sourceBucket
              )
            } catch (awsErr: unknown) {
              message = `${message} | S3 check: ${formatAwsError(awsErr)}`
            }

            await updateMigrationItem(item.id, {
              slurperStatus: "precheck_failed",
              progress: {
                ...(item.progress ?? {}),
                stage: "precheck_source",
                error: message,
                sourceModeTried: sourceSpecS3.vendor,
                sourceFallbackTried: sourceSpecR2.vendor,
              },
              lastProgressAt: new Date().toISOString(),
            })
            return
          }
        }

        const forceRerunNoOverwrite =
          (isRecord(item.progress) ? (item.progress as Record<string, unknown>).rerunNoOverwrite : undefined) ===
          true
        const rerunCountRaw =
          isRecord(item.progress) && typeof (item.progress as Record<string, unknown>).rerunCount === "number"
            ? ((item.progress as Record<string, unknown>).rerunCount as number)
            : 0
        const rerunCount = Number.isFinite(rerunCountRaw) ? Math.max(0, Math.floor(rerunCountRaw)) : 0
        const jobName = forceRerunNoOverwrite
          ? `drive-migration-${migration.id}-${item.id}-rerun-${rerunCount || 1}-${Date.now()}`
          : `drive-migration-${migration.id}-${item.id}`
        const claimed = await claimMigrationItemJobCreation({
          itemId: item.id,
          progress: { ...(item.progress ?? {}), stage: "create_job", jobName },
        })
        if (!claimed) return

        // Extra safety: if a job already exists for this item (from a previous request),
        // attach it instead of creating another one.
        const existingJobId = forceRerunNoOverwrite
          ? null
          : await slurperFindJobIdForBuckets({
              accountId: target.cloudflareAccountId!,
              apiToken: target.apiToken,
              sourceBucket: item.sourceBucket,
              targetBucket: item.targetBucket,
              jobName,
              requireNonTerminal: true,
              createdWithinMs: 10 * 60_000,
            }).catch(() => null)

        if (existingJobId) {
          await updateMigrationItem(item.id, {
            slurperJobId: String(existingJobId),
            slurperStatus: "running",
            progress: { ...(item.progress ?? {}), stage: "job_attached", jobName },
            lastProgressAt: new Date().toISOString(),
          })
          return
        }

        const result = await slurperCreateJob({
          accountId: target.cloudflareAccountId!,
          apiToken: target.apiToken,
          job: {
            overwrite: forceRerunNoOverwrite ? false : overwrite,
            jobName,
            configuration: {
              overwriteObjects: forceRerunNoOverwrite ? false : overwrite,
            },
            source: effectiveSource,
            target: {
              vendor: "r2",
              bucket: item.targetBucket,
              secret: {
                accessKeyId: target.r2AccessKeyId!,
                secretAccessKey: target.r2SecretAccessKey!,
              },
              jurisdiction: mapToJurisdiction(item.sourceJurisdiction),
            },
          },
        })

        const jobId =
          slurperExtractCreatedJobId(result) ??
          (await slurperFindJobIdForBuckets({
            accountId: target.cloudflareAccountId!,
            apiToken: target.apiToken,
            sourceBucket: item.sourceBucket,
            targetBucket: item.targetBucket,
            jobName,
            createdWithinMs: 2 * 60_000,
            requireNonTerminal: true,
          }).catch(() => null))

        if (!jobId) {
          await updateMigrationItem(item.id, {
            slurperJobId: null,
            slurperStatus: "job_id_pending",
            progress: { ...(item.progress ?? {}), stage: "job_id_missing", jobName, lastError: "Cloudflare did not return a job id" },
            lastProgressAt: new Date().toISOString(),
          })
          return
        }

        await updateMigrationItem(item.id, {
          slurperJobId: String(jobId),
          slurperStatus: "running",
          progress: { ...(item.progress ?? {}), stage: "job_created", jobName, sourceModeUsed: effectiveSource.vendor },
          lastProgressAt: new Date().toISOString(),
        })
      } catch (error: unknown) {
        if (isJobLimitReached(error)) {
          const message = `${formatCloudflareError(error, "Cloudflare concurrent job limit reached")} (will retry as jobs finish)`
          await updateMigrationItem(item.id, {
            slurperJobId: null,
            slurperStatus: "queued",
            progress: { ...(item.progress ?? {}), stage: "cloudflare_job_limit", error: message },
            lastProgressAt: new Date().toISOString(),
          })
          return
        }
        if (isRateLimited(error)) {
          const delay = typeof error.retryAfterMs === "number" ? error.retryAfterMs : 5_000
          const message = `${formatCloudflareError(error, "Cloudflare rate limited job creation")} (retry in ~${Math.ceil(delay / 1000)}s)`
          await updateMigrationItem(item.id, {
            slurperJobId: null,
            slurperStatus: "queued",
            progress: { ...(item.progress ?? {}), stage: "rate_limited_job_create", error: message },
            lastProgressAt: new Date().toISOString(),
          })
          return
        }
        const message = formatCloudflareError(error, "Unable to create Super Slurper job")
        await updateMigrationItem(item.id, {
          slurperJobId: null,
          slurperStatus: "job_create_failed",
          progress: {
            ...(item.progress ?? {}),
            error: message,
            stage: "create_job",
            jobCreateRetries:
              typeof (item.progress as Record<string, unknown> | undefined)?.jobCreateRetries === "number"
                ? ((item.progress as Record<string, unknown>).jobCreateRetries as number) + 1
                : 1,
          },
          lastProgressAt: new Date().toISOString(),
        })
      }
    })

    const refreshedItems = await listMigrationItems(id)
    await updateMigration(id, {
      syncStatus: "ok",
      syncMessage: "Migration started",
      lastSyncedAt: new Date().toISOString(),
    })

    return NextResponse.json({ migration: await getMigration(id), items: refreshedItems }, { status: 200 })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unable to start migration")
        : "Unable to start migration"
    return NextResponse.json(
      { error: message },
      { status: 400 }
    )
  }
}
