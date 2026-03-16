import { cloudflareFetchJson } from "./cloudflare-api"

export type SlurperJurisdiction = "default" | "eu" | "fedramp"

export type SlurperSource =
  | {
      vendor: "s3"
      bucket: string
      secret: { accessKeyId: string; secretAccessKey: string }
      endpoint?: string
      region?: string
      pathPrefix?: string | null
    }
  | {
      vendor: "gcs"
      bucket: string
      secret: { clientEmail: string; privateKey: string }
      pathPrefix?: string | null
    }
  | {
      vendor: "r2"
      bucket: string
      secret: { accessKeyId: string; secretAccessKey: string }
      jurisdiction?: SlurperJurisdiction
      pathPrefix?: string | null
    }

export type SlurperTarget = {
  vendor: "r2"
  bucket: string
  secret: { accessKeyId: string; secretAccessKey: string }
  jurisdiction?: SlurperJurisdiction
}

export type SlurperJobCreateRequest = {
  // Historical/alternate field name in some docs.
  overwrite?: boolean
  // Optional job name (used by Cloudflare dashboard examples).
  jobName?: string
  source: SlurperSource
  target: SlurperTarget
  // Alternate configuration shape used by Cloudflare dashboard examples.
  configuration?: { overwriteObjects?: boolean }
}

export type CloudflareApiEnvelope<T> = {
  success?: boolean
  errors?: Array<{ code?: number; message?: string }>
  messages?: string[]
  result?: T
}

export type SlurperJobCreateResult = { id: string }

export type SlurperJobProgress = {
  id: string
  createdAt?: string
  status?: string
  objects?: number
  transferredObjects?: number
  skippedObjects?: number
  failedObjects?: number
}

export type SlurperJobListItem = {
  id?: string
  status?: string
}

function getStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function getStringFromRecord(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = record[key]
    const s = getStringField(v)
    if (s) return s
  }
  return undefined
}

function getRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = record[key]
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined
}

function getNestedString(record: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = record
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return getStringField(current)
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`)
  }
  return value
}

export async function slurperConnectivityPrecheckSource(input: {
  accountId: string
  apiToken: string
  body: SlurperSource
}) {
  requireText(input.accountId, "accountId")
  const payload = await cloudflareFetchJson<unknown>({
    apiToken: input.apiToken,
    method: "PUT",
    path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/source/connectivity-precheck`,
    body: input.body,
  })
  return normalizeEnvelope<unknown>(payload)
}

export async function slurperConnectivityPrecheckTarget(input: {
  accountId: string
  apiToken: string
  body: SlurperTarget
}) {
  requireText(input.accountId, "accountId")
  const payload = await cloudflareFetchJson<unknown>({
    apiToken: input.apiToken,
    method: "PUT",
    path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/target/connectivity-precheck`,
    body: input.body,
  })
  return normalizeEnvelope<unknown>(payload)
}

export async function slurperCreateJob(input: {
  accountId: string
  apiToken: string
  job: SlurperJobCreateRequest
}) {
  requireText(input.accountId, "accountId")
  const payload = await cloudflareFetchJson<unknown>({
    apiToken: input.apiToken,
    method: "POST",
    path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/jobs`,
    body: input.job,
  })
  return normalizeEnvelope<SlurperJobCreateResult>(payload)
}

export async function slurperListJobs(input: { accountId: string; apiToken: string }) {
  requireText(input.accountId, "accountId")
  const payload = await cloudflareFetchJson<unknown>({
    apiToken: input.apiToken,
    path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/jobs`,
  })
  return normalizeEnvelope<unknown>(payload)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isEnvelope(value: unknown): value is CloudflareApiEnvelope<unknown> {
  if (!isRecord(value)) return false
  return "result" in value || "success" in value || "errors" in value || "messages" in value
}

function normalizeEnvelope<T>(payload: unknown): CloudflareApiEnvelope<T> {
  if (isEnvelope(payload)) return payload as CloudflareApiEnvelope<T>
  if (Array.isArray(payload)) return { result: payload as unknown as T }
  if (typeof payload === "undefined") return {}
  return { result: payload as T }
}

function parseSlurperJobsResult(result: unknown): SlurperJobListItem[] {
  const direct = Array.isArray(result) ? result : []
  if (direct.length > 0) return direct.map((v) => (isRecord(v) ? v : {}))

  if (!isRecord(result)) return []

  const candidates = [
    (result as { jobs?: unknown }).jobs,
    (result as { items?: unknown }).items,
    (result as { result?: unknown }).result,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map((v) => (isRecord(v) ? v : {}))
  }
  return []
}

export async function slurperGetActiveJobCount(input: { accountId: string; apiToken: string }): Promise<number> {
  const envelope = await slurperListJobs(input)
  const list = parseSlurperJobsResult(envelope?.result)

  // We count all non-terminal jobs as "active" because they occupy Cloudflare concurrency slots.
  const terminalStatuses = new Set([
    "completed",
    "complete",
    "finished",
    "success",
    "succeeded",
    "aborted",
    "canceled",
    "cancelled",
    "failed",
    "error",
  ])

  let count = 0
  for (const raw of list) {
    const status = typeof raw?.status === "string" ? raw.status.toLowerCase() : ""
    if (!status) continue
    if (terminalStatuses.has(status)) continue
    count += 1
  }
  return count
}

export function slurperExtractCreatedJobId(envelope: CloudflareApiEnvelope<unknown> | unknown): string | undefined {
  if (isRecord(envelope)) {
    const top = getStringFromRecord(envelope, ["id", "jobId", "job_id"])
    if (top) return top
  }

  const env = (typeof envelope === "object" && envelope !== null ? (envelope as CloudflareApiEnvelope<unknown>) : {}) as {
    result?: unknown
  }
  const result = env?.result

  if (typeof result === "string" && result.trim()) return result.trim()

  if (typeof result === "object" && result !== null) {
    const rec = result as Record<string, unknown>
    const direct = getStringFromRecord(rec, ["id", "jobId", "job_id"])
    if (direct) return direct

    const job = getRecordField(rec, "job")
    if (job) {
      const nested = getStringFromRecord(job, ["id", "jobId", "job_id"])
      if (nested) return nested
    }
  }

  return undefined
}

export async function slurperFindJobIdForBuckets(input: {
  accountId: string
  apiToken: string
  sourceBucket: string
  targetBucket: string
  jobName?: string
  createdWithinMs?: number
  requireNonTerminal?: boolean
}): Promise<string | null> {
  const envelope = await slurperListJobs({ accountId: input.accountId, apiToken: input.apiToken })
  const list = parseSlurperJobsResult(envelope?.result)

  const matches: Array<{ id: string; createdAtMs: number }> = []
  const withinMs = typeof input.createdWithinMs === "number" && Number.isFinite(input.createdWithinMs)
    ? Math.max(1_000, Math.min(10 * 60_000, Math.floor(input.createdWithinMs)))
    : undefined
  const requireNonTerminal = Boolean(input.requireNonTerminal)
  const terminalStatuses = new Set([
    "completed",
    "complete",
    "finished",
    "success",
    "succeeded",
    "aborted",
    "canceled",
    "cancelled",
    "failed",
    "error",
  ])
  for (const raw of list) {
    if (!isRecord(raw)) continue

    const id = getStringFromRecord(raw, ["id", "jobId", "job_id"]) ?? getNestedString(raw, ["job", "id"])
    if (!id) continue

    if (requireNonTerminal) {
      const status = getStringFromRecord(raw, ["status"]) ?? getNestedString(raw, ["job", "status"]) ?? ""
      const s = status ? status.toLowerCase() : ""
      if (s && terminalStatuses.has(s)) continue
    }

    const jobName = getStringFromRecord(raw, ["jobName", "job_name", "name"]) ?? getNestedString(raw, ["job", "name"])

    const srcBucket =
      getNestedString(raw, ["source", "bucket"]) ??
      getNestedString(raw, ["source", "bucket_name"]) ??
      getStringFromRecord(raw, ["sourceBucket", "source_bucket"])

    const dstBucket =
      getNestedString(raw, ["target", "bucket"]) ??
      getNestedString(raw, ["target", "bucket_name"]) ??
      getStringFromRecord(raw, ["targetBucket", "target_bucket"])

    if (srcBucket !== input.sourceBucket) continue
    if (dstBucket !== input.targetBucket) continue

    if (input.jobName && jobName && jobName !== input.jobName) {
      // If we have a jobName, prefer matching it exactly.
      continue
    }

    const createdAtStr =
      getStringFromRecord(raw, ["createdAt", "created_at", "created"]) ?? getNestedString(raw, ["job", "createdAt"])
    const createdAtMs = createdAtStr ? Date.parse(createdAtStr) : 0
    const created = Number.isFinite(createdAtMs) ? createdAtMs : 0
    if (withinMs && created > 0) {
      if (Date.now() - created > withinMs) continue
    }
    matches.push({ id, createdAtMs: created })
  }

  if (matches.length === 0) return null
  matches.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))
  return matches[0].id
}

export async function slurperGetJob(input: {
  accountId: string
  apiToken: string
  jobId: string
}) {
  requireText(input.accountId, "accountId")
  requireText(input.jobId, "jobId")
  const payload = await cloudflareFetchJson<unknown>({
    apiToken: input.apiToken,
    path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/jobs/${encodeURIComponent(input.jobId)}`,
  })
  return normalizeEnvelope<unknown>(payload)
}

export async function slurperGetJobProgress(input: {
  accountId: string
  apiToken: string
  jobId: string
}) {
  requireText(input.accountId, "accountId")
  requireText(input.jobId, "jobId")
  const payload = await cloudflareFetchJson<unknown>({
    apiToken: input.apiToken,
    path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/jobs/${encodeURIComponent(input.jobId)}/progress`,
  })
  return normalizeEnvelope<SlurperJobProgress>(payload)
}

export async function slurperListJobLogs(input: {
  accountId: string
  apiToken: string
  jobId: string
  page?: number
  perPage?: number
  cursor?: string
}) {
  requireText(input.accountId, "accountId")
  requireText(input.jobId, "jobId")
  const query = new URLSearchParams()
  if (typeof input.page === "number" && Number.isFinite(input.page) && input.page > 0) {
    query.set("page", String(Math.floor(input.page)))
  }
  if (typeof input.perPage === "number" && Number.isFinite(input.perPage) && input.perPage > 0) {
    query.set("per_page", String(Math.floor(input.perPage)))
  }
  if (typeof input.cursor === "string" && input.cursor.trim().length > 0) {
    query.set("cursor", input.cursor.trim())
  }
  const querySuffix = query.toString() ? `?${query.toString()}` : ""
  const payload = await cloudflareFetchJson<unknown>({
    apiToken: input.apiToken,
    path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/jobs/${encodeURIComponent(input.jobId)}/logs${querySuffix}`,
  })
  return normalizeEnvelope<unknown>(payload)
}

export async function slurperPauseJob(input: {
  accountId: string
  apiToken: string
  jobId: string
}) {
  requireText(input.accountId, "accountId")
  requireText(input.jobId, "jobId")
  const payload = await cloudflareFetchJson<unknown>({
    apiToken: input.apiToken,
    method: "PUT",
    path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/jobs/${encodeURIComponent(input.jobId)}/pause`,
  })
  return normalizeEnvelope<unknown>(payload)
}

export async function slurperResumeJob(input: {
  accountId: string
  apiToken: string
  jobId: string
}) {
  requireText(input.accountId, "accountId")
  requireText(input.jobId, "jobId")
  const payload = await cloudflareFetchJson<unknown>({
    apiToken: input.apiToken,
    method: "PUT",
    path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/jobs/${encodeURIComponent(input.jobId)}/resume`,
  })
  return normalizeEnvelope<unknown>(payload)
}

export async function slurperAbortJob(input: {
  accountId: string
  apiToken: string
  jobId: string
}) {
  requireText(input.accountId, "accountId")
  requireText(input.jobId, "jobId")
  const payload = await cloudflareFetchJson<unknown>({
    apiToken: input.apiToken,
    method: "PUT",
    path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/jobs/${encodeURIComponent(input.jobId)}/abort`,
  })
  return normalizeEnvelope<unknown>(payload)
}

export async function slurperAbortAllJobs(input: { accountId: string; apiToken: string }) {
  requireText(input.accountId, "accountId")
  const payload = await cloudflareFetchJson<unknown>({
    apiToken: input.apiToken,
    method: "PUT",
    path: `/accounts/${encodeURIComponent(input.accountId)}/slurper/jobs/abortAll`,
  })
  return normalizeEnvelope<unknown>(payload)
}
