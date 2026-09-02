/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const { PutObjectCommand, S3Client, UploadPartCommand } = require("@aws-sdk/client-s3")
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner")

const r2Source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "r2-s3.ts"), "utf8")

function testClient() {
  return new S3Client({
    region: "auto",
    endpoint: "https://account-id.r2.cloudflarestorage.com",
    credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })
}

test("R2 direct presigns do not add unsupported checksum parameters", async () => {
  assert.match(r2Source, /requestChecksumCalculation:\s*["']WHEN_REQUIRED["']/)
  assert.match(r2Source, /responseChecksumValidation:\s*["']WHEN_REQUIRED["']/)
  assert.match(r2Source, /unhoistableHeaders:\s*metadataHeaders/)
  assert.match(r2Source, /signableHeaders\.size > 0/)

  const url = await getSignedUrl(
    testClient(),
    new PutObjectCommand({
      Bucket: "deepfakelive",
      Key: "assests/Admin/probe.txt",
      ContentType: "text/plain",
      Metadata: { "drive-sync-fingerprint": "marker" },
    }),
    {
      expiresIn: 3600,
      signableHeaders: new Set(["content-type"]),
      unhoistableHeaders: new Set(["x-amz-meta-drive-sync-fingerprint"]),
    }
  )
  const query = new URL(url).searchParams

  assert.equal(query.get("X-Amz-SignedHeaders"), "content-type;host;x-amz-meta-drive-sync-fingerprint")
  assert.equal(query.has("x-amz-sdk-checksum-algorithm"), false)
  assert.equal(query.has("x-amz-checksum-crc32"), false)
  assert.equal(query.has("x-amz-meta-drive-sync-fingerprint"), false)
})

test("R2 multipart part presigns do not add unsupported checksum parameters", async () => {
  const url = await getSignedUrl(
    testClient(),
    new UploadPartCommand({
      Bucket: "deepfakelive",
      Key: "assests/Admin/probe.bin",
      UploadId: "upload-id",
      PartNumber: 1,
    }),
    { expiresIn: 3600 }
  )
  const query = new URL(url).searchParams

  assert.equal(query.get("X-Amz-SignedHeaders"), "host")
  assert.equal(query.has("x-amz-sdk-checksum-algorithm"), false)
  assert.equal(query.has("x-amz-checksum-crc32"), false)
})
