import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import type { Readable } from "stream"

export interface R2ClientConfig {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
}

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

export function createR2Client({
  accountId,
  accessKeyId,
  secretAccessKey,
}: R2ClientConfig) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })
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
  return client.send(new HeadBucketCommand({ Bucket: bucket }))
}

export async function r2ListOneObject(config: R2ClientConfig, bucket: string) {
  const client = createR2Client(config)
  return client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }))
}

export async function r2ListObjectsPage(
  config: R2ClientConfig,
  bucket: string,
  input: { continuationToken?: string; prefix?: string; maxKeys?: number; startAfter?: string }
) {
  const client = createR2Client(config)
  return sendWithRetry(() =>
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
) {
  const client = createR2Client(config)
  return sendWithRetry(() =>
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

export async function r2HeadObject(config: R2ClientConfig, bucket: string, key: string) {
  const client = createR2Client(config)
  return client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
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
  const encodedSource = `${bucket}/${sourceKey}`
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")
  return client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: encodedSource,
      Key: destinationKey,
      ...(options?.ifMatch ? { CopySourceIfMatch: options.ifMatch } : {}),
      ...(options?.metadata ? { Metadata: options.metadata } : {}),
      ...(options?.contentType ? { ContentType: options.contentType } : {}),
      ...(options?.metadataDirective ? { MetadataDirective: options.metadataDirective } : {}),
    })
  )
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

export async function r2CreateSignedDownloadUrl(
  config: R2ClientConfig,
  bucket: string,
  key: string,
  input?: { expiresInSeconds?: number; filename?: string; contentType?: string }
) {
  const client = createR2Client(config)
  const expiresInSeconds =
    typeof input?.expiresInSeconds === "number" && Number.isFinite(input.expiresInSeconds)
      ? Math.max(30, Math.min(3600, Math.floor(input.expiresInSeconds)))
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
  })

  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
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
  const maxObjects = Math.max(1, Math.min(200_000, input?.maxObjects ?? 50_000))
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
