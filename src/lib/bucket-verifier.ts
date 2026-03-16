import crypto from "crypto"
import { Readable } from "stream"
import { r2GetObjectStream, r2HeadObject, r2ListObjectsPage } from "./r2-s3"
import type { R2ClientConfig } from "./r2-s3"

export type BucketVerifyMode = "keys-and-size" | "sha256-small"

export type BucketVerifyState = {
  status: "pending" | "running" | "ok" | "error"
  startedAt?: string
  finishedAt?: string
  updatedAt?: string
  prefix?: string
  note?: string

  // Resumable cursors for ListObjectsV2(StartAfter=...).
  sourceAfterKey?: string
  destAfterKey?: string
  sourceDone?: boolean
  destDone?: boolean

  // Cumulative counters.
  sourceListedObjects?: number
  destListedObjects?: number
  comparedObjects?: number
  hashedObjects?: number
  missingInDest?: number
  sizeMismatched?: number
  hashMismatched?: number
  extraInDest?: number
  phantomExtraInDest?: number

  // Small samples (for UI/debugging).
  sampleMissingKeys?: string[]
  sampleMismatchedKeys?: string[]
  sampleHashMismatchedKeys?: string[]
  sampleExtraKeys?: string[]

  lastError?: string
}

export type BucketVerifyRunOptions = {
  prefix?: string
  mode?: BucketVerifyMode
  strictDestination?: boolean
  maxComparisons?: number
  maxHeadChecks?: number
  maxHashes?: number
  hashMaxBytes?: number
  sampleLimit?: number
}

type ListedObj = { key: string; size: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.map((v) => String(v)).filter(Boolean)
  return out.length ? out : []
}

export function readBucketVerifyState(progress: Record<string, unknown>): BucketVerifyState | null {
  const verify = isRecord(progress.verify) ? (progress.verify as Record<string, unknown>) : null
  if (!verify) return null

  const status = asString(verify.status)
  if (status !== "pending" && status !== "running" && status !== "ok" && status !== "error") return null

  return {
    status,
    startedAt: asString(verify.startedAt),
    finishedAt: asString(verify.finishedAt),
    updatedAt: asString(verify.updatedAt),
    prefix: asString(verify.prefix),
    note: asString(verify.note),
    sourceAfterKey: asString(verify.sourceAfterKey),
    destAfterKey: asString(verify.destAfterKey),
    sourceDone: asBool(verify.sourceDone),
    destDone: asBool(verify.destDone),
    sourceListedObjects: asNumber(verify.sourceListedObjects),
    destListedObjects: asNumber(verify.destListedObjects),
    comparedObjects: asNumber(verify.comparedObjects),
    hashedObjects: asNumber(verify.hashedObjects),
    missingInDest: asNumber(verify.missingInDest),
    sizeMismatched: asNumber(verify.sizeMismatched),
    hashMismatched: asNumber(verify.hashMismatched),
    extraInDest: asNumber(verify.extraInDest),
    phantomExtraInDest: asNumber(verify.phantomExtraInDest),
    sampleMissingKeys: asStringArray(verify.sampleMissingKeys),
    sampleMismatchedKeys: asStringArray(verify.sampleMismatchedKeys),
    sampleHashMismatchedKeys: asStringArray(verify.sampleHashMismatchedKeys),
    sampleExtraKeys: asStringArray(verify.sampleExtraKeys),
    lastError: asString(verify.lastError),
  }
}

export function createInitialBucketVerifyState(input?: { prefix?: string }): BucketVerifyState {
  const now = new Date().toISOString()
  return {
    status: "pending",
    startedAt: now,
    updatedAt: now,
    prefix: input?.prefix,
    note: "",
    sourceListedObjects: 0,
    destListedObjects: 0,
    comparedObjects: 0,
    hashedObjects: 0,
    missingInDest: 0,
    sizeMismatched: 0,
    hashMismatched: 0,
    extraInDest: 0,
    phantomExtraInDest: 0,
    sampleMissingKeys: [],
    sampleMismatchedKeys: [],
    sampleHashMismatchedKeys: [],
    sampleExtraKeys: [],
  }
}

function pushSample(list: string[], key: string, limit: number) {
  if (list.length >= limit) return
  list.push(key)
}

function normalizeAwsError(error: unknown): string {
  if (typeof error !== "object" || error === null) return "Unknown S3 error"
  const maybe = error as { name?: unknown; message?: unknown; Code?: unknown; code?: unknown }
  const code = typeof maybe.Code === "string" ? maybe.Code : typeof maybe.code === "string" ? maybe.code : ""
  const name = typeof maybe.name === "string" ? maybe.name : ""
  const message = typeof maybe.message === "string" ? maybe.message : ""
  const parts = [code || name, message].filter((p) => p && String(p).trim())
  return parts.length ? parts.join(": ") : "Unknown S3 error"
}

async function listNextPage(
  config: R2ClientConfig,
  bucket: string,
  input: { prefix?: string; startAfter?: string }
): Promise<ListedObj[]> {
  const page = await r2ListObjectsPage(config, bucket, {
    prefix: input.prefix,
    startAfter: input.startAfter,
    maxKeys: 1000,
  })

  const contents = Array.isArray(page.Contents) ? page.Contents : []
  const out: ListedObj[] = []
  for (const obj of contents) {
    const key = typeof obj?.Key === "string" ? obj.Key : ""
    if (!key) continue
    const size = typeof obj?.Size === "number" && Number.isFinite(obj.Size) ? obj.Size : 0
    out.push({ key, size })
  }
  return out
}

async function headExists(config: R2ClientConfig, bucket: string, key: string): Promise<boolean> {
  try {
    await r2HeadObject(config, bucket, key)
    return true
  } catch (e: unknown) {
    const msg = normalizeAwsError(e).toLowerCase()
    if (msg.includes("nosuchkey") || msg.includes("notfound") || msg.includes("not found") || msg.includes("404")) {
      return false
    }
    // Unknown; treat as exists to avoid masking real problems.
    return true
  }
}

async function sha256FromBody(body: unknown): Promise<string> {
  if (!body) throw new Error("Empty object body")

  // AWS SDK v3 in Node usually returns a Readable stream.
  if (body instanceof Readable) {
    const hash = crypto.createHash("sha256")
    await new Promise<void>((resolve, reject) => {
      body.on("data", (chunk) => hash.update(chunk))
      body.on("error", reject)
      body.on("end", () => resolve())
    })
    return hash.digest("hex")
  }

  // Fallback (less ideal) for non-Readable bodies.
  if (typeof body === "string") return crypto.createHash("sha256").update(body).digest("hex")
  if (body instanceof Uint8Array) return crypto.createHash("sha256").update(body).digest("hex")

  // Some runtimes expose transformToByteArray().
  if (typeof body === "object" && body !== null && "transformToByteArray" in body) {
    const fn = (body as { transformToByteArray?: unknown }).transformToByteArray
    if (typeof fn === "function") {
      const bytes = await (fn as () => Promise<Uint8Array>)()
      return crypto.createHash("sha256").update(bytes).digest("hex")
    }
  }

  throw new Error("Unsupported object body type for hashing")
}

async function sha256ForObject(config: R2ClientConfig, bucket: string, key: string): Promise<string> {
  const res = await r2GetObjectStream(config, bucket, key)
  const body = (res as { Body?: unknown }).Body
  return sha256FromBody(body)
}

export async function verifyBucketsIncremental(input: {
  source: { config: R2ClientConfig; bucket: string }
  dest: { config: R2ClientConfig; bucket: string }
  state: BucketVerifyState
  options?: BucketVerifyRunOptions
}): Promise<BucketVerifyState> {
  const now = new Date().toISOString()
  const options: {
    prefix?: string
    mode: BucketVerifyMode
    strictDestination: boolean
    maxComparisons: number
    maxHeadChecks: number
    maxHashes: number
    hashMaxBytes: number
    sampleLimit: number
  } = {
    prefix: input.options?.prefix ?? input.state.prefix ?? undefined,
    mode: input.options?.mode ?? "keys-and-size",
    strictDestination: input.options?.strictDestination ?? false,
    maxComparisons: Math.max(100, Math.min(200_000, input.options?.maxComparisons ?? 10_000)),
    maxHeadChecks: Math.max(0, Math.min(20_000, input.options?.maxHeadChecks ?? 200)),
    maxHashes: Math.max(0, Math.min(10_000, input.options?.maxHashes ?? 50)),
    hashMaxBytes: Math.max(
      0,
      Math.min(5 * 1024 * 1024 * 1024, input.options?.hashMaxBytes ?? 8 * 1024 * 1024)
    ),
    sampleLimit: Math.max(1, Math.min(200, input.options?.sampleLimit ?? 25)),
  }

  if (options.mode !== "keys-and-size" && options.mode !== "sha256-small") {
    return { ...input.state, status: "error", updatedAt: now, lastError: `Unsupported verify mode: ${options.mode}` }
  }

  const state: BucketVerifyState = {
    ...createInitialBucketVerifyState({ prefix: options.prefix }),
    ...input.state,
    status: input.state.status === "ok" ? "ok" : "running",
    updatedAt: now,
    prefix: options.prefix,
  }

  if (state.status === "ok") return state
  if (state.sourceDone && state.destDone) {
    state.status = "ok"
    state.finishedAt = state.finishedAt ?? now
    return state
  }

  let sourceBuf: ListedObj[] = []
  let destBuf: ListedObj[] = []
  let sourceIdx = 0
  let destIdx = 0

  let headChecks = 0
  let hashes = 0

  const getNextSource = async (): Promise<ListedObj | null> => {
    if (state.sourceDone) return null
    if (sourceIdx < sourceBuf.length) return sourceBuf[sourceIdx]
    sourceBuf = await listNextPage(input.source.config, input.source.bucket, {
      prefix: options.prefix,
      startAfter: state.sourceAfterKey,
    })
    sourceIdx = 0
    if (sourceBuf.length === 0) {
      state.sourceDone = true
      return null
    }
    return sourceBuf[sourceIdx]
  }

  const getNextDest = async (): Promise<ListedObj | null> => {
    if (state.destDone) return null
    if (destIdx < destBuf.length) return destBuf[destIdx]
    destBuf = await listNextPage(input.dest.config, input.dest.bucket, {
      prefix: options.prefix,
      startAfter: state.destAfterKey,
    })
    destIdx = 0
    if (destBuf.length === 0) {
      state.destDone = true
      return null
    }
    return destBuf[destIdx]
  }

  const consumeSource = (obj: ListedObj) => {
    state.sourceAfterKey = obj.key
    state.sourceListedObjects = (state.sourceListedObjects ?? 0) + 1
    sourceIdx += 1
  }
  const consumeDest = (obj: ListedObj) => {
    state.destAfterKey = obj.key
    state.destListedObjects = (state.destListedObjects ?? 0) + 1
    destIdx += 1
  }

  for (let i = 0; i < options.maxComparisons; i += 1) {
    const s = await getNextSource()

    // If we are not enforcing destination strictness, once we've verified every source key
    // we can finish immediately without walking the entire destination (which might contain
    // many unrelated/previous objects in merge scenarios).
    if (!s && !options.strictDestination && state.sourceDone) {
      state.destDone = true
      break
    }

    const d = await getNextDest()

    if (!s && !d) break

    if (s && !d) {
      state.missingInDest = (state.missingInDest ?? 0) + 1
      pushSample(state.sampleMissingKeys ?? [], s.key, options.sampleLimit)
      consumeSource(s)
      continue
    }

    if (!s && d) {
      if (!options.strictDestination && state.sourceDone) {
        state.destDone = true
        break
      }
      // Destination has extra objects (could be expected in merge scenarios).
      let phantom = false
      if (headChecks < options.maxHeadChecks) {
        headChecks += 1
        phantom = !(await headExists(input.dest.config, input.dest.bucket, d.key))
      }

      if (phantom) {
        state.phantomExtraInDest = (state.phantomExtraInDest ?? 0) + 1
      } else {
        state.extraInDest = (state.extraInDest ?? 0) + 1
        pushSample(state.sampleExtraKeys ?? [], d.key, options.sampleLimit)
      }

      consumeDest(d)
      continue
    }

    // Both present.
    if (!s || !d) break

    if (s.key === d.key) {
      state.comparedObjects = (state.comparedObjects ?? 0) + 1
      if (s.size !== d.size) {
        state.sizeMismatched = (state.sizeMismatched ?? 0) + 1
        pushSample(state.sampleMismatchedKeys ?? [], s.key, options.sampleLimit)
      } else if (
        options.mode === "sha256-small" &&
        s.size > 0 &&
        s.size <= options.hashMaxBytes &&
        hashes < options.maxHashes
      ) {
        hashes += 1
        state.hashedObjects = (state.hashedObjects ?? 0) + 1
        try {
          const [srcHash, dstHash] = await Promise.all([
            sha256ForObject(input.source.config, input.source.bucket, s.key),
            sha256ForObject(input.dest.config, input.dest.bucket, d.key),
          ])
          if (srcHash !== dstHash) {
            state.hashMismatched = (state.hashMismatched ?? 0) + 1
            pushSample(state.sampleHashMismatchedKeys ?? [], s.key, options.sampleLimit)
          }
        } catch (e: unknown) {
          const message =
            typeof e === "object" && e !== null && "message" in e
              ? String((e as { message?: unknown }).message ?? "Hashing failed")
              : "Hashing failed"
          state.hashMismatched = (state.hashMismatched ?? 0) + 1
          pushSample(state.sampleHashMismatchedKeys ?? [], `${s.key} (hash error: ${message})`, options.sampleLimit)
        }
      }
      consumeSource(s)
      consumeDest(d)
      continue
    }

    if (s.key < d.key) {
      state.missingInDest = (state.missingInDest ?? 0) + 1
      pushSample(state.sampleMissingKeys ?? [], s.key, options.sampleLimit)
      consumeSource(s)
      continue
    }

    // d.key < s.key
    let phantom = false
    if (headChecks < options.maxHeadChecks) {
      headChecks += 1
      phantom = !(await headExists(input.dest.config, input.dest.bucket, d.key))
    }

    if (phantom) {
      state.phantomExtraInDest = (state.phantomExtraInDest ?? 0) + 1
    } else {
      state.extraInDest = (state.extraInDest ?? 0) + 1
      pushSample(state.sampleExtraKeys ?? [], d.key, options.sampleLimit)
    }
    consumeDest(d)
  }

  if (state.sourceDone && state.destDone) {
    const missing = state.missingInDest ?? 0
    const mismatched = state.sizeMismatched ?? 0
    const hashMismatched = state.hashMismatched ?? 0
    const extra = state.extraInDest ?? 0
    const sourceListed = state.sourceListedObjects ?? 0

    const ok =
      missing === 0 &&
      mismatched === 0 &&
      hashMismatched === 0 &&
      (!options.strictDestination || extra === 0)
    state.status = ok ? "ok" : "error"
    state.finishedAt = now
    if (!ok) {
      state.lastError =
        missing > 0
          ? `Verification failed: ${missing} source objects missing in destination`
          : mismatched > 0
            ? `Verification failed: ${mismatched} objects have size mismatches`
            : hashMismatched > 0
              ? `Verification failed: ${hashMismatched} objects have SHA-256 mismatches`
            : `Verification failed: ${extra} extra objects in destination`
      state.note = ""
    } else if (sourceListed === 0) {
      // Distinguish truly-empty source buckets from "skipped" semantics.
      state.note = "no_source_objects"
    } else if (!options.strictDestination && state.sourceDone && state.destDone && (state.destListedObjects ?? 0) > 0) {
      state.note = "destination_extras_ignored"
    } else {
      state.note = ""
    }
  } else {
    state.status = "running"
  }

  state.updatedAt = new Date().toISOString()
  return state
}
