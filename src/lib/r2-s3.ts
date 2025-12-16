import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import type { Readable } from "stream"

interface R2ClientConfig {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
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

export async function r2PutObject(
  config: R2ClientConfig,
  bucket: string,
  key: string,
  body: Buffer | Uint8Array | string | Readable
) {
  const client = createR2Client(config)

  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
    },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  })

  return upload.done()
}
