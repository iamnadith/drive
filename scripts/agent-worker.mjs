import { S3Client, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import os from "os"

function getArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return process.env[name.toUpperCase().replace(/-/g, "_")] || fallback
}

const SERVER_URL = String(getArg("server-url", "")).replace(/\/+$/, "")
const AGENT_ID = String(getArg("agent-id", ""))
const AGENT_TOKEN = String(getArg("token", ""))
const POLL_MS = Math.max(5_000, Number(getArg("poll-ms", "15000")) || 15_000)
const HEARTBEAT_MS = Math.max(10_000, Number(getArg("heartbeat-ms", "20000")) || 20_000)
const MAX_OBJECTS = Math.max(1, Math.min(500_000, Number(getArg("max-objects", "200000")) || 200_000))

if (!SERVER_URL || !AGENT_ID || !AGENT_TOKEN) {
  console.error("Missing required configuration. Use --server-url, --agent-id, and --token.")
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class JobAbortedError extends Error {
  constructor(message = "Worker job aborted by user") {
    super(message)
    this.name = "JobAbortedError"
  }
}

function createClient(config) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

async function api(path, body) {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof json.error === "string" ? json.error : `Request failed: ${response.status}`)
  }
  return json
}

async function heartbeat(extra = {}) {
  return api(`/api/agents/${encodeURIComponent(AGENT_ID)}/heartbeat`, {
    token: AGENT_TOKEN,
    host: os.hostname(),
    version: "worker-v1",
    capabilities: ["scan", "verify", "repair", "diagnostics"],
    metadata: extra,
  })
}

async function claimJob() {
  return api(`/api/agents/${encodeURIComponent(AGENT_ID)}/claim-job`, {
    token: AGENT_TOKEN,
  })
}

async function updateJob(jobId, body) {
  const response = await api(`/api/agents/${encodeURIComponent(AGENT_ID)}/jobs/${encodeURIComponent(jobId)}`, {
    token: AGENT_TOKEN,
    ...body,
  })
  if (response?.canceled || response?.job?.status === "canceled") {
    throw new JobAbortedError()
  }
  return response
}

async function listAllObjects(client, bucket, prefix) {
  const objects = []
  let continuationToken = undefined
  while (true) {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      })
    )
    const contents = Array.isArray(page.Contents) ? page.Contents : []
    for (const object of contents) {
      const key = typeof object?.Key === "string" ? object.Key : ""
      if (!key) continue
      const size = typeof object?.Size === "number" ? object.Size : 0
      objects.push({ key, size })
      if (objects.length >= MAX_OBJECTS) return objects
    }
    continuationToken = typeof page.NextContinuationToken === "string" ? page.NextContinuationToken : undefined
    if (!continuationToken) return objects
  }
}

function diffObjects(sourceObjects, destObjects) {
  const destinationMap = new Map(destObjects.map((object) => [object.key, object.size]))
  const missing = []
  const mismatched = []
  for (const sourceObject of sourceObjects) {
    const destSize = destinationMap.get(sourceObject.key)
    if (typeof destSize === "undefined") {
      missing.push(sourceObject)
    } else if (destSize !== sourceObject.size) {
      mismatched.push({ ...sourceObject, destinationSize: destSize })
    }
  }
  return { missing, mismatched }
}

function buildLiveTotals(resultItems, current = {}) {
  const completedItems = Array.isArray(resultItems) ? resultItems : []
  const totals = {
    transferred: 0,
    failed: 0,
    skipped: 0,
    missing: 0,
    mismatched: 0,
    completedItems: 0,
    failedItems: 0,
  }

  for (const item of completedItems) {
    totals.transferred += Number(item?.transferred || 0)
    totals.failed += Number(item?.failed || 0)
    totals.skipped += Number(item?.skipped || 0)
    totals.missing += Number(item?.finalMissing || 0)
    totals.mismatched += Number(item?.finalMismatched || 0)
    if (item?.completed) totals.completedItems += 1
    else totals.failedItems += 1
  }

  totals.transferred += Number(current.transferred || 0)
  totals.failed += Number(current.failed || 0)
  totals.skipped += Number(current.skipped || 0)
  totals.missing += Number(current.missing || 0)
  totals.mismatched += Number(current.mismatched || 0)

  return totals
}

async function copyObject(sourceClient, targetClient, sourceBucket, targetBucket, key) {
  const sourceResponse = await sourceClient.send(new GetObjectCommand({ Bucket: sourceBucket, Key: key }))
  const sourceHead = await sourceClient.send(new HeadObjectCommand({ Bucket: sourceBucket, Key: key }))
  const body = sourceResponse.Body
  if (!body) throw new Error(`Source object body missing for ${key}`)

  const upload = new Upload({
    client: targetClient,
    params: {
      Bucket: targetBucket,
      Key: key,
      Body: body,
      ...(typeof sourceHead.ContentType === "string" ? { ContentType: sourceHead.ContentType } : {}),
      ...(typeof sourceHead.CacheControl === "string" ? { CacheControl: sourceHead.CacheControl } : {}),
      ...(sourceHead.Metadata ? { Metadata: sourceHead.Metadata } : {}),
    },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  })

  await upload.done()
  const targetHead = await targetClient.send(new HeadObjectCommand({ Bucket: targetBucket, Key: key }))
  const sourceSize = typeof sourceHead.ContentLength === "number" ? sourceHead.ContentLength : 0
  const targetSize = typeof targetHead.ContentLength === "number" ? targetHead.ContentLength : -1
  if (targetSize !== sourceSize) {
    throw new Error(`Size mismatch after copy for ${key}: source=${sourceSize} target=${targetSize}`)
  }
}

async function processItem(jobId, payload, item, completedResults) {
  const prefix = payload.migration?.pathPrefix || null
  const sourceClient = createClient(payload.source)
  const targetClient = createClient(payload.target)

  await updateJob(jobId, {
    status: "running",
    items: [
      {
        itemId: item.id,
        stage: "repair_scan",
        status: "running",
        summary: `Scanning ${item.sourceBucket} -> ${item.targetBucket}`,
      },
    ],
    progress: {
      currentItemId: item.id,
      currentBucket: item.sourceBucket,
      stage: "repair_scan",
      totals: buildLiveTotals(completedResults),
    },
  })

  const sourceObjects = await listAllObjects(sourceClient, item.sourceBucket, prefix)
  const destinationObjects = await listAllObjects(targetClient, item.targetBucket, prefix)
  const initialDiff = diffObjects(sourceObjects, destinationObjects)
  const initialMissing = initialDiff.missing.length
  const initialMismatched = initialDiff.mismatched.length

  const toRepair = [...initialDiff.missing, ...initialDiff.mismatched]
  let transferred = 0
  let failed = 0
  let skipped = 0
  const failureSamples = []

  if (payload.job.mode !== "verify_only") {
    for (const object of toRepair) {
      try {
        await copyObject(sourceClient, targetClient, item.sourceBucket, item.targetBucket, object.key)
        transferred += 1
      } catch (error) {
        failed += 1
        if (failureSamples.length < 25) {
          failureSamples.push({
            key: object.key,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      await updateJob(jobId, {
        status: "running",
        items: [
          {
            itemId: item.id,
            stage: "repair_copy",
            status: "running",
            summary: `Repairing ${item.sourceBucket}: ${transferred} copied, ${failed} failed`,
            transferred,
            failed,
            skipped,
            details: {
              initialMissing,
              initialMismatched,
              attempted: transferred + failed,
              remaining: Math.max(0, toRepair.length - transferred - failed),
            },
          },
        ],
        progress: {
          currentItemId: item.id,
          stage: "repair_copy",
          currentBucket: item.sourceBucket,
          transferred,
          failed,
          skipped,
          totals: buildLiveTotals(completedResults, {
            transferred,
            failed,
            skipped,
          }),
        },
      })
    }
  } else {
    skipped = toRepair.length
  }

  const finalDestinationObjects = await listAllObjects(targetClient, item.targetBucket, prefix)
  const finalDiff = diffObjects(sourceObjects, finalDestinationObjects)
  const finalMissing = finalDiff.missing.length
  const finalMismatched = finalDiff.mismatched.length
  const completed = finalMissing === 0 && finalMismatched === 0

  await updateJob(jobId, {
    status: "running",
    items: [
      {
        itemId: item.id,
        stage: "repair_verify",
        status: completed ? "completed" : "failed",
        summary: completed
          ? `Repair verified for ${item.sourceBucket}`
          : `Repair incomplete for ${item.sourceBucket}: ${finalMissing} missing, ${finalMismatched} mismatched`,
        transferred,
        failed,
        skipped,
        details: {
          initialMissing,
          initialMismatched,
          finalMissing,
          finalMismatched,
          failureSamples,
        },
      },
    ],
    progress: {
      currentItemId: item.id,
      stage: "repair_verify",
      currentBucket: item.sourceBucket,
      transferred,
      failed,
      skipped,
      finalMissing,
      finalMismatched,
      totals: buildLiveTotals(completedResults, {
        transferred,
        failed,
        skipped,
        missing: finalMissing,
        mismatched: finalMismatched,
      }),
    },
  })

  return {
    itemId: item.id,
    sourceBucket: item.sourceBucket,
    targetBucket: item.targetBucket,
    initialMissing,
    initialMismatched,
    transferred,
    failed,
    skipped,
    finalMissing,
    finalMismatched,
    completed,
    failureSamples,
  }
}

async function runJob(job, payload) {
  const results = []
  for (const item of Array.isArray(payload.items) ? payload.items : []) {
    results.push(await processItem(job.id, payload, item, results))
  }

  const totalMissing = results.reduce((sum, item) => sum + item.finalMissing, 0)
  const totalMismatched = results.reduce((sum, item) => sum + item.finalMismatched, 0)
  const totalTransferred = results.reduce((sum, item) => sum + item.transferred, 0)
  const totalFailed = results.reduce((sum, item) => sum + item.failed, 0)
  const completed = totalMissing === 0 && totalMismatched === 0 && totalFailed === 0

  await updateJob(job.id, {
    status: completed ? "completed" : "failed",
    summary: completed
      ? `Worker reconciliation completed: ${totalTransferred} repaired objects`
      : `Worker reconciliation incomplete: ${totalMissing} missing, ${totalMismatched} mismatched, ${totalFailed} copy failures`,
    error: completed ? null : "One or more items still have missing/mismatched files after worker repair",
    result: {
      items: results,
      totals: {
        transferred: totalTransferred,
        failed: totalFailed,
        skipped: results.reduce((sum, item) => sum + item.skipped, 0),
        missing: totalMissing,
        mismatched: totalMismatched,
      },
    },
    progress: {
      stage: "completed",
      active: false,
      totals: {
        transferred: totalTransferred,
        failed: totalFailed,
        skipped: results.reduce((sum, item) => sum + item.skipped, 0),
        missing: totalMissing,
        mismatched: totalMismatched,
        completedItems: results.filter((item) => item.completed).length,
        failedItems: results.filter((item) => !item.completed).length,
      },
    },
  })
}

let currentJobId = null

async function startHeartbeatLoop() {
  while (true) {
    try {
      await heartbeat(currentJobId ? { currentJobId } : {})
      if (currentJobId) {
        await updateJob(currentJobId, {
          progress: { heartbeatAt: new Date().toISOString(), active: true },
        }).catch(() => {})
      }
    } catch (error) {
      console.error("Heartbeat failed:", error instanceof Error ? error.message : String(error))
    }
    await sleep(HEARTBEAT_MS)
  }
}

async function main() {
  console.log(`Worker starting for agent ${AGENT_ID} at ${SERVER_URL}`)
  void startHeartbeatLoop()

  while (true) {
    try {
      const claimed = await claimJob()
      if (!claimed?.job || !claimed?.payload) {
        await sleep(POLL_MS)
        continue
      }

      currentJobId = claimed.job.id
      console.log(`Claimed job ${claimed.job.id} for migration ${claimed.payload?.migration?.id || "-"}`)
      await runJob(claimed.job, claimed.payload)
      console.log(`Finished job ${claimed.job.id}`)
      currentJobId = null
    } catch (error) {
      console.error("Worker loop error:", error instanceof Error ? error.message : String(error))
      if (currentJobId) {
        if (error instanceof JobAbortedError) {
          console.log(`Job ${currentJobId} aborted by user`)
        } else {
          try {
            await updateJob(currentJobId, {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
              summary: "Worker crashed while processing repair job",
            })
          } catch {}
        }
      }
      currentJobId = null
      await sleep(POLL_MS)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
