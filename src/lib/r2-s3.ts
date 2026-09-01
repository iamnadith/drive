import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  DeleteBucketCorsCommand,
  type CORSRule,
  type CreateMultipartUploadCommandOutput,
  type HeadBucketCommandOutput,
  type HeadObjectCommandOutput,
  type ListObjectsV2CommandOutput,
  type UploadPartCopyCommandOutput,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import type { Readable } from "stream"

declare global {
  var __driveR2ClientCache: Map<string, S3Client> | undefined
}

export interface R2ClientConfig {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
}

const SINGLE_COPY_SIZE_LIMIT_BYTES = 4.5 * 1024 * 1024 * 1024
const MULTIPART_COPY_MIN_PART_SIZE_BYTES = 64 * 1024 * 1024
const MULTIPART_COPY_PART_SIZE_ALIGNMENT_BYTES = 8 * 1024 * 1024
const MULTIPART_COPY_MAX_PARTS = 10_000
const MULTIPART_COPY_CONCURRENCY = 4

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableR2Error(error: unknown): boolean {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "").toLowerCase()
      : String(error ?? "").toLowerCase()

  if (
    message.includes("fetch failed") ||
    message.includes("failed to fetch") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("eai_again") ||
    message.includes("socket hang up") ||
    message.includes("network")
  ) {
    return true
  }

  const status =
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    typeof (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === "number"
      ? (error as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode
      : undefined

  return typeof status === "number" && (status === 429 || status >= 500)
}

async function sendWithRetry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isRetryableR2Error(error) || i === attempts - 1) throw error
      const backoffMs = 250 * 2 ** i + Math.floor(Math.random() * 120)
      await sleep(backoffMs)
    }
  }
  throw lastError
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function buildEncodedCopySource(bucket: string, key: string) {
  return `${bucket}/${key}`
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")
}

function alignPartSize(size: number) {
  return Math.ceil(size / MULTIPART_COPY_PART_SIZE_ALIGNMENT_BYTES) *
    MULTIPART_COPY_PART_SIZE_ALIGNMENT_BYTES
}

function getMultipartCopyPartSize(totalBytes: number) {
  const minimumSizeNeeded = Math.ceil(totalBytes / MULTIPART_COPY_MAX_PARTS)
  return alignPartSize(
    Math.max(MULTIPART_COPY_MIN_PART_SIZE_BYTES, minimumSizeNeeded)
  )
}

const COPY_VISIBILITY_ATTEMPTS = 8
const COPY_VISIBILITY_DELAY_MS = 500

async function waitForCopiedObject(
  client: S3Client,
  bucket: string,
  key: string,
  expectedSize: number,
) {
  let lastError: unknown
  let lastSize: number | undefined

  for (let attempt = 0; attempt < COPY_VISIBILITY_ATTEMPTS; attempt += 1) {
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      lastSize = numberValue(head.ContentLength)
      if (lastSize === expectedSize) return head
      lastError = new Error(
        `Copied object size mismatch for ${key}: expected=${expectedSize} actual=${lastSize ?? "unknown"}`
      )
    } catch (error) {
      lastError = error
    }

    if (attempt < COPY_VISIBILITY_ATTEMPTS - 1) {
      await sleep(COPY_VISIBILITY_DELAY_MS)
    }
  }

  if (lastSize !== undefined) {
    throw lastError instanceof Error
      ? lastError
      : new Error(
          `Copied object size mismatch for ${key}: expected=${expectedSize} actual=${lastSize}`
        )
  }
  throw new Error(`Copied object is not readable after copy: ${key}`)
}

export function createR2Client({
  accountId,
  accessKeyId,
  secretAccessKey,
}: R2ClientConfig) {
  // S3Client keeps its HTTP connection pool alive. Reusing it avoids a new
  // TLS/agent setup for every authenticated HEAD during registration scans.
  const cache = global.__driveR2ClientCache ??= new Map()
  const cacheKey = `${accountId}:${accessKeyId}:${secretAccessKey}`
  const cached = cache.get(cacheKey)
  if (cached) return cached
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  cache.set(cacheKey, client)
  // Account credentials can be rotated. Keep the cache bounded so old
  // clients do not accumulate in a long-lived Next.js process.
  while (cache.size > 8) {
    const oldest = cache.keys().next().value
    if (typeof oldest !== "string") break
    const oldClient = cache.get(oldest)
    cache.delete(oldest)
    void oldClient?.destroy()
  }
  return client
}

export async function r2CreateBucket(config: R2ClientConfig, bucket: string) {
  const client = createR2Client(config)
  const command = new CreateBucketCommand({ Bucket: bucket })
  return client.send(command)
}

export async function r2DeleteBucket(config: R2ClientConfig, bucket: string) {
  const client = createR2Client(config)
  return client.send(new DeleteBucketCommand({ Bucket: bucket }))
}

export async function r2PutObject(
  config: R2ClientConfig,
  bucket: string,
  key: string,
  body: Buffer | Uint8Array | string | Readable,
  options?: {
    contentType?: string
    cacheControl?: string
    metadata?: Record<string, string>
    ifMatch?: string
    ifNoneMatch?: string
  }
) {
  const client = createR2Client(config)

  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
      ...(options?.contentType ? { ContentType: options.contentType } : {}),
      ...(options?.cacheControl ? { CacheControl: options.cacheControl } : {}),
      ...(options?.metadata ? { Metadata: options.metadata } : {}),
      ...(options?.ifMatch ? { IfMatch: options.ifMatch } : {}),
      ...(options?.ifNoneMatch ? { IfNoneMatch: options.ifNoneMatch } : {}),
    },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  })

  return upload.done()
}

export async function r2CreateSignedUploadUrl(
  config: R2ClientConfig,
  bucket: string,
  key: string,
  input?: {
    expiresInSeconds?: number
    contentType?: string
    metadata?: Record<string, string>
    ifMatch?: string
    ifNoneMatch?: string
  }
) {
  const client = createR2Client(config)
  const expiresInSeconds =
    typeof input?.expiresInSeconds === "number" && Number.isFinite(input.expiresInSeconds)
      ? Math.max(30, Math.min(3600, Math.floor(input.expiresInSeconds)))
      : 900
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(input?.contentType ? { ContentType: input.contentType } : {}),
    ...(input?.metadata ? { Metadata: input.metadata } : {}),
    ...(input?.ifMatch ? { IfMatch: input.ifMatch } : {}),
    ...(input?.ifNoneMatch ? { IfNoneMatch: input.ifNoneMatch } : {}),
  })
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

export async function r2HeadBucket(config: R2ClientConfig, bucket: string) {
  const client = createR2Client(config)
  return client.send(new HeadBucketCommand({ Bucket: bucket })) as Promise<HeadBucketCommandOutput>
}

export async function r2GetBucketCors(
  config: R2ClientConfig,
  bucket: string
): Promise<CORSRule[]> {
  const client = createR2Client(config)
  try {
    const result = await client.send(new GetBucketCorsCommand({ Bucket: bucket }))
    return result.CORSRules ?? []
  } catch (error: unknown) {
    const status =
      typeof error === "object" && error !== null && "$metadata" in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined
    const name =
      typeof error === "object" && error !== null && "name" in error
        ? String((error as { name?: unknown }).name ?? "")
        : ""
    if (status === 404 || name === "NoSuchCORSConfiguration") return []
    throw error
  }
}

export async function r2PutBucketCors(
  config: R2ClientConfig,
  bucket: string,
  rules: CORSRule[]
) {
  const client = createR2Client(config)
  return client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: { CORSRules: rules },
    })
  )
}

export async function r2DeleteBucketCors(config: R2ClientConfig, bucket: string) {
  const client = createR2Client(config)
  return client.send(new DeleteBucketCorsCommand({ Bucket: bucket }))
}

export async function r2ListOneObject(config: R2ClientConfig, bucket: string) {
  const client = createR2Client(config)
  return client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }))
}

export async function r2ListObjectsPage(
  config: R2ClientConfig,
  bucket: string,
  input: { continuationToken?: string; prefix?: string; maxKeys?: number; startAfter?: string }
): Promise<ListObjectsV2CommandOutput> {
  const client = createR2Client(config)
  return sendWithRetry<ListObjectsV2CommandOutput>(() =>
    client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: input.prefix,
        ContinuationToken: input.continuationToken,
        StartAfter: input.startAfter,
        MaxKeys: input.maxKeys ?? 1000,
      })
    )
  )
}

export async function r2ListObjectsPageWithDelimiter(
  config: R2ClientConfig,
  bucket: string,
  input: { continuationToken?: string; prefix?: string; maxKeys?: number; delimiter?: string }
): Promise<ListObjectsV2CommandOutput> {
  const client = createR2Client(config)
  return sendWithRetry<ListObjectsV2CommandOutput>(() =>
    client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: input.prefix,
        ContinuationToken: input.continuationToken,
        MaxKeys: input.maxKeys ?? 1000,
        Delimiter: input.delimiter,
      })
    )
  )
}

export async function r2HeadObject(config: R2ClientConfig, bucket: string, key: string): Promise<HeadObjectCommandOutput> {
  const client = createR2Client(config)
  return client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })) as Promise<HeadObjectCommandOutput>
}

export async function r2CopyObject(
  config: R2ClientConfig,
  bucket: string,
  sourceKey: string,
  destinationKey: string,
  options?: {
    ifMatch?: string
    metadata?: Record<string, string>
    contentType?: string
    metadataDirective?: "COPY" | "REPLACE"
  }
) {
  const client = createR2Client(config)
  const encodedSource = buildEncodedCopySource(bucket, sourceKey)
  // These reads are independent. Running them together is important for
  // registration retries: two cold R2 HEADs in series can exceed the worker's
  // request deadline even when the destination already matches exactly.
  const [sourceHead, existingHead] = await Promise.all([
    sendWithRetry<HeadObjectCommandOutput>(
      () => client.send(new HeadObjectCommand({ Bucket: bucket, Key: sourceKey }))
    ),
    sourceKey === destinationKey
      ? Promise.resolve<HeadObjectCommandOutput | null>(null)
      : client
        .send(new HeadObjectCommand({ Bucket: bucket, Key: destinationKey }))
        .catch(() => null),
  ])
  const sourceSize = numberValue(sourceHead.ContentLength) ?? 0

  // Registration retries are intentionally idempotent. If a prior request
  // completed the copy but the response was lost, return the existing exact
  // object instead of starting another copy or multipart upload.
  if (existingHead && numberValue(existingHead.ContentLength) === sourceSize) {
    return existingHead
  }

  const multipartCopy = async () => {
    const metadataDirective = options?.metadataDirective ?? "COPY"
    const upload = await sendWithRetry<CreateMultipartUploadCommandOutput>(() =>
      client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: destinationKey,
          ...(metadataDirective === "REPLACE"
            ? {
                ...(options?.metadata ? { Metadata: options.metadata } : {}),
                ...(options?.contentType ? { ContentType: options.contentType } : {}),
              }
            : {
                ...(sourceHead.Metadata ? { Metadata: sourceHead.Metadata } : {}),
                ...(options?.contentType || sourceHead.ContentType
                  ? { ContentType: options?.contentType ?? sourceHead.ContentType }
                  : {}),
                ...(sourceHead.CacheControl
                  ? { CacheControl: sourceHead.CacheControl }
                  : {}),
                ...(sourceHead.ContentDisposition
                  ? { ContentDisposition: sourceHead.ContentDisposition }
                  : {}),
                ...(sourceHead.ContentEncoding
                  ? { ContentEncoding: sourceHead.ContentEncoding }
                  : {}),
                ...(sourceHead.ContentLanguage
                  ? { ContentLanguage: sourceHead.ContentLanguage }
                  : {}),
              }),
        })
      )
    )
    const uploadId = upload.UploadId
    if (!uploadId) {
      throw new Error(`Multipart copy did not return an uploadId for ${destinationKey}`)
    }

    const partSize = getMultipartCopyPartSize(sourceSize)
    const partCount = Math.max(1, Math.ceil(sourceSize / partSize))
    const parts = Array.from({ length: partCount }, (_, index) => {
      const start = index * partSize
      const end = Math.min(sourceSize - 1, start + partSize - 1)
      return {
        partNumber: index + 1,
        range: `bytes=${start}-${end}`,
      }
    })
    const completedParts: Array<{ partNumber: number; etag: string }> = []
    let nextPartIndex = 0

    const copyPartWorker = async () => {
      while (nextPartIndex < parts.length) {
        const currentPartIndex = nextPartIndex
        nextPartIndex += 1
        const currentPart = parts[currentPartIndex]
        if (!currentPart) {
          return
        }

        const copiedPart = await sendWithRetry<UploadPartCopyCommandOutput>(() =>
          client.send(
            new UploadPartCopyCommand({
              Bucket: bucket,
              Key: destinationKey,
              UploadId: uploadId,
              PartNumber: currentPart.partNumber,
              CopySource: encodedSource,
              CopySourceRange: currentPart.range,
              ...(options?.ifMatch ? { CopySourceIfMatch: options.ifMatch } : {}),
            })
          )
        )
        const etag = copiedPart.CopyPartResult?.ETag
        if (!etag) {
          throw new Error(
            `Multipart copy did not return an ETag for part ${currentPart.partNumber}`
          )
        }
        completedParts[currentPartIndex] = {
          partNumber: currentPart.partNumber,
          etag,
        }
      }
    }

    try {
      await Promise.all(
        Array.from(
          { length: Math.min(MULTIPART_COPY_CONCURRENCY, parts.length) },
          () => copyPartWorker()
        )
      )
      await sendWithRetry(() =>
        client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: destinationKey,
            UploadId: uploadId,
            MultipartUpload: {
              Parts: completedParts
                .map((part) => ({
                  PartNumber: part.partNumber,
                  ETag: part.etag,
                }))
                .sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0)),
            },
          })
        )
      )
    } catch (error) {
      const copiedHead = await client
        .send(new HeadObjectCommand({ Bucket: bucket, Key: destinationKey }))
        .catch(() => null)
      if (
        copiedHead &&
        (numberValue(copiedHead.ContentLength) ?? -1) === sourceSize
      ) {
        return copiedHead
      }
      await client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: destinationKey,
            UploadId: uploadId,
          })
        )
        .catch(() => undefined)
      throw error
    }

    const destinationHead = await sendWithRetry<HeadObjectCommandOutput>(() =>
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: destinationKey }))
    )
    const destinationSize = numberValue(destinationHead.ContentLength) ?? -1
    if (destinationSize !== sourceSize) {
      throw new Error(
        `Size mismatch after multipart copy for ${destinationKey}: source=${sourceSize} destination=${destinationSize}`
      )
    }
    return destinationHead
  }

  if (sourceSize > SINGLE_COPY_SIZE_LIMIT_BYTES) {
    return multipartCopy()
  }

  try {
    await sendWithRetry(() =>
      client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: encodedSource,
          Key: destinationKey,
          ...(options?.ifMatch ? { CopySourceIfMatch: options.ifMatch } : {}),
          ...(options?.metadata ? { Metadata: options.metadata } : {}),
          ...(options?.contentType ? { ContentType: options.contentType } : {}),
          ...(options?.metadataDirective
            ? { MetadataDirective: options.metadataDirective }
            : {}),
        })
      )
    )
    // CopyObject can acknowledge before a subsequent HEAD observes the
    // destination. Do not report success until the copied object is readable
    // and has the same size as the source.
    return await waitForCopiedObject(client, bucket, destinationKey, sourceSize)
  } catch (error) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "").toLowerCase()
        : String(error ?? "").toLowerCase()
    if (
      sourceSize > 0 &&
      (message.includes("entity too large") ||
        message.includes("invalidrequest") ||
        message.includes("copyobject") ||
        message.includes("multipart"))
    ) {
      return multipartCopy()
    }
    throw error
  }
}

export async function r2UpdateObjectMetadata(
  config: R2ClientConfig,
  bucket: string,
  key: string,
  input: { metadata?: Record<string, string>; contentType?: string; ifMatch?: string }
) {
  return r2CopyObject(config, bucket, key, key, {
    metadata: input.metadata ?? {},
    contentType: input.contentType,
    ifMatch: input.ifMatch,
    metadataDirective: "REPLACE",
  })
}

export async function r2GetObjectStream(config: R2ClientConfig, bucket: string, key: string) {
  const client = createR2Client(config)
  return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
}

export async function r2DeleteObject(config: R2ClientConfig, bucket: string, key: string) {
  const client = createR2Client(config)
  return client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
}

export async function r2DeleteObjects(config: R2ClientConfig, bucket: string, keys: string[]) {
  const client = createR2Client(config)
  const uniqueKeys = Array.from(new Set(keys)).filter(Boolean)
  for (let i = 0; i < uniqueKeys.length; i += 1000) {
    const chunk = uniqueKeys.slice(i, i + 1000)
    if (!chunk.length) continue
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    )
  }
}

export async function r2DeleteObjectVersions(config: R2ClientConfig, bucket: string, versions: Array<{ key: string; versionId?: string }>) {
  const client = createR2Client(config)
  const unique = Array.from(new Map(versions.filter((item) => item.key).map((item) => [`${item.key}:${item.versionId ?? ""}`, item])).values())
  for (let i = 0; i < unique.length; i += 1000) {
    await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: unique.slice(i, i + 1000).map((item) => ({ Key: item.key, ...(item.versionId ? { VersionId: item.versionId } : {}) })), Quiet: true },
    }))
  }
}

export async function r2DeleteBucketAndContents(config: R2ClientConfig, bucket: string) {
  const objects = await r2ListAllObjects(config, bucket, { maxObjects: 200_000 })
  if (objects.length > 0) {
    await r2DeleteObjects(
      config,
      bucket,
      objects.map((object) => object.key)
    )
  }
  await r2DeleteBucket(config, bucket)
}

export type R2MultipartUpload = { key: string; uploadId: string; initiated?: string }

export async function r2ListAllMultipartUploads(config: R2ClientConfig, bucket: string, maxUploads = 200_000): Promise<R2MultipartUpload[]> {
  const client = createR2Client(config)
  const uploads: R2MultipartUpload[] = []
  let keyMarker: string | undefined
  let uploadIdMarker: string | undefined
  while (uploads.length < maxUploads) {
    const page = await client.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}),
      MaxUploads: Math.min(1000, maxUploads - uploads.length),
    }))
    for (const upload of page.Uploads ?? []) {
      if (upload.Key && upload.UploadId) uploads.push({ key: upload.Key, uploadId: upload.UploadId, initiated: upload.Initiated?.toISOString() })
    }
    if (!page.IsTruncated || !page.NextKeyMarker || !page.NextUploadIdMarker) break
    keyMarker = page.NextKeyMarker
    uploadIdMarker = page.NextUploadIdMarker
  }
  return uploads
}

export async function r2AbortAllMultipartUploads(config: R2ClientConfig, bucket: string) {
  const uploads = await r2ListAllMultipartUploads(config, bucket)
  for (const upload of uploads) await r2AbortMultipartUpload(config, bucket, upload.key, upload.uploadId)
  return { discovered: uploads.length, aborted: uploads.length }
}

export async function r2ListAllObjectVersions(config: R2ClientConfig, bucket: string, maxObjects = 200_000) {
  const client = createR2Client(config)
  const versions: Array<{ key: string; versionId?: string }> = []
  let keyMarker: string | undefined
  let versionIdMarker: string | undefined
  while (versions.length < maxObjects) {
    const page = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      MaxKeys: Math.min(1000, maxObjects - versions.length),
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
    }))
    for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) if (item.Key) versions.push({ key: item.Key, versionId: item.VersionId })
    if (!page.IsTruncated || !page.NextKeyMarker) break
    keyMarker = page.NextKeyMarker
    versionIdMarker = page.NextVersionIdMarker
  }
  return versions
}

export async function r2DeleteAllBucketContents(config: R2ClientConfig, bucket: string) {
  let objectsCount = 0
  let versionsCount = 0
  let multipartCount = 0
  while (true) {
    const objects = await r2ListAllObjects(config, bucket, { maxObjects: 1000 })
    let versions: Array<{ key: string; versionId?: string }> = []
    try { versions = await r2ListAllObjectVersions(config, bucket, 1000) } catch { /* R2 may not expose version listing. */ }
    const multipart = await r2ListAllMultipartUploads(config, bucket, 1000)
    if (!objects.length && !versions.length && !multipart.length) break
    await r2DeleteObjects(config, bucket, objects.map((item) => item.key))
    await r2DeleteObjectVersions(config, bucket, versions)
    for (const upload of multipart) await r2AbortMultipartUpload(config, bucket, upload.key, upload.uploadId)
    objectsCount += objects.length
    versionsCount += versions.length
    multipartCount += multipart.length
  }
  return { objects: objectsCount, versions: versionsCount, multipart: multipartCount }
}

export async function r2CreateSignedDownloadUrl(
  config: R2ClientConfig,
  bucket: string,
  key: string,
  input?: {
    expiresInSeconds?: number
    filename?: string
    contentType?: string
    cacheControl?: string
  }
) {
  const client = createR2Client(config)
  const expiresInSeconds =
    typeof input?.expiresInSeconds === "number" && Number.isFinite(input.expiresInSeconds)
      ? Math.max(30, Math.min(604800, Math.floor(input.expiresInSeconds)))
      : 300

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(typeof input?.filename === "string" && input.filename.trim()
      ? {
          ResponseContentDisposition: `attachment; filename="${input.filename.trim().replace(/"/g, "")}"`,
        }
      : {}),
    ...(typeof input?.contentType === "string" && input.contentType.trim()
      ? { ResponseContentType: input.contentType.trim() }
      : {}),
    ...(typeof input?.cacheControl === "string" && input.cacheControl.trim()
      ? { ResponseCacheControl: input.cacheControl.trim() }
      : {}),
  })

  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

export async function r2CreateSignedHeadUrl(
  config: R2ClientConfig,
  bucket: string,
  key: string,
  input?: { expiresInSeconds?: number }
) {
  const client = createR2Client(config)
  const expiresInSeconds =
    typeof input?.expiresInSeconds === "number" && Number.isFinite(input.expiresInSeconds)
      ? Math.max(30, Math.min(3600, Math.floor(input.expiresInSeconds)))
      : 300

  return getSignedUrl(
    client,
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expiresInSeconds }
  )
}

export async function r2CreateMultipartUpload(
  config: R2ClientConfig,
  bucket: string,
  key: string,
  input?: { contentType?: string; metadata?: Record<string, string> }
) {
  const client = createR2Client(config)
  return client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ...(input?.contentType ? { ContentType: input.contentType } : {}),
      ...(input?.metadata ? { Metadata: input.metadata } : {}),
    })
  )
}

export async function r2CreateSignedMultipartPartUrl(
  config: R2ClientConfig,
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresInSeconds = 900
) {
  const client = createR2Client(config)
  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  })
  return getSignedUrl(client, command, {
    expiresIn: Math.max(30, Math.min(3600, Math.floor(expiresInSeconds))),
  })
}

export async function r2CompleteMultipartUpload(
  config: R2ClientConfig,
  bucket: string,
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>
) {
  const client = createR2Client(config)
  return client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts
          .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag }))
          .sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0)),
      },
    })
  )
}

export async function r2AbortMultipartUpload(
  config: R2ClientConfig,
  bucket: string,
  key: string,
  uploadId: string
) {
  const client = createR2Client(config)
  return client.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
    })
  )
}

export async function r2ListAllObjects(
  config: R2ClientConfig,
  bucket: string,
  input?: { prefix?: string; maxObjects?: number }
): Promise<Array<{ key: string; size: number; lastModified?: string }>> {
  const maxObjects = Math.max(
    1,
    Math.min(200_000, Math.floor(numberValue(input?.maxObjects) ?? 50_000))
  )
  const objects: Array<{ key: string; size: number; lastModified?: string }> = []

  let continuationToken: string | undefined = undefined
  while (true) {
    const page = await r2ListObjectsPage(config, bucket, {
      continuationToken,
      prefix: input?.prefix,
      maxKeys: 1000,
    })

    const contents = Array.isArray(page.Contents) ? page.Contents : []
    for (const obj of contents) {
      const key = typeof obj?.Key === "string" ? obj.Key : ""
      if (!key) continue
      const size = typeof obj?.Size === "number" && Number.isFinite(obj.Size) ? obj.Size : 0
      const lastModified =
        obj?.LastModified instanceof Date ? obj.LastModified.toISOString() : undefined
      objects.push({ key, size, lastModified })
      if (objects.length >= maxObjects) return objects
    }

    const next =
      typeof page.NextContinuationToken === "string" ? page.NextContinuationToken : undefined
    if (!next) return objects
    continuationToken = next
  }
}

export async function r2ComputeBucketStats(
  config: R2ClientConfig,
  bucket: string,
  input?: { prefix?: string }
): Promise<{ objects: number; bytes: number }> {
  let objects = 0
  let bytes = 0
  let continuationToken: string | undefined = undefined

  while (true) {
    const page = await r2ListObjectsPage(config, bucket, {
      continuationToken,
      prefix: input?.prefix,
      maxKeys: 1000,
    })

    const contents = Array.isArray(page.Contents) ? page.Contents : []
    for (const obj of contents) {
      const key = typeof obj?.Key === "string" ? obj.Key : ""
      if (!key) continue
      objects += 1
      if (typeof obj?.Size === "number" && Number.isFinite(obj.Size)) bytes += obj.Size
    }

    const next =
      typeof page.NextContinuationToken === "string" ? page.NextContinuationToken : undefined
    if (!next) break
    continuationToken = next
  }

  return { objects, bytes }
}
