export type CloudflareApiErrorPayload = {
  success?: boolean
  errors?: Array<{ code?: number; message?: string }>
  messages?: string[]
  result?: unknown
}

export class CloudflareApiError extends Error {
  status: number
  payloadText?: string
  payloadJson?: unknown
  retryAfterMs?: number

  constructor(
    message: string,
    options: { status: number; payloadText?: string; payloadJson?: unknown; retryAfterMs?: number }
  ) {
    super(message)
    this.name = "CloudflareApiError"
    this.status = options.status
    this.payloadText = options.payloadText
    this.payloadJson = options.payloadJson
    this.retryAfterMs = options.retryAfterMs
  }
}

function extractCloudflareErrorMessage(payloadJson: unknown, fallback: string): string {
  if (typeof payloadJson !== "object" || payloadJson === null) return fallback
  const maybe = payloadJson as { errors?: unknown; messages?: unknown; result?: unknown }
  const errors = Array.isArray(maybe.errors) ? maybe.errors : []
  const first = errors[0]
  if (typeof first === "object" && first !== null) {
    const code = (first as { code?: unknown }).code
    const message = (first as { message?: unknown }).message
    const parts = []
    if (typeof code === "number") parts.push(`code ${code}`)
    if (typeof message === "string" && message.trim()) parts.push(message.trim())
    if (parts.length) return parts.join(": ")
  }
  const messages = Array.isArray(maybe.messages) ? maybe.messages : []
  const firstMsg = messages.find((m) => typeof m === "string" && m.trim())
  if (typeof firstMsg === "string") return firstMsg.trim()
  return fallback
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function getRetryAfterMs(res: Response, payloadJson: unknown): number | undefined {
  const retryAfter = res.headers.get("Retry-After")
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(120_000, Math.floor(seconds * 1000))
  }

  // Cloudflare sometimes returns code 971 for rate limiting in the JSON payload.
  if (typeof payloadJson === "object" && payloadJson !== null) {
    const errors = Array.isArray((payloadJson as { errors?: unknown }).errors)
      ? ((payloadJson as { errors?: Array<{ code?: unknown }> }).errors ?? [])
      : []
    const has971 = errors.some((e) => typeof e?.code === "number" && e.code === 971)
    if (has971) return 5_000
  }

  return undefined
}

// Global Cloudflare API throttling: serializes requests and enforces a minimum gap to avoid 429s.
let cloudflareGate: Promise<void> = Promise.resolve()
let nextCloudflareAllowedAt = 0
const MIN_CLOUDFLARE_GAP_MS = 200

async function withCloudflareGate<T>(fn: () => Promise<T>): Promise<T> {
  const run = cloudflareGate.then(async () => {
    const now = Date.now()
    const delay = Math.max(0, nextCloudflareAllowedAt - now)
    if (delay > 0) await sleep(delay)
    nextCloudflareAllowedAt = Date.now() + MIN_CLOUDFLARE_GAP_MS
    return fn()
  })

  cloudflareGate = run.then(
    () => undefined,
    () => undefined
  )

  return run
}

export async function cloudflareFetchJson<T>(
  input: {
    apiToken: string
    path: string
    method?: string
    body?: unknown
    query?: Record<string, string | number | boolean | undefined>
    headers?: Record<string, string>
  },
  options?: { retries?: number; timeoutMs?: number }
): Promise<T> {
  const retries = options?.retries ?? 3
  const timeoutMs = options?.timeoutMs ?? 30_000

  const url = new URL(`https://api.cloudflare.com/client/v4${input.path}`)
  if (input.query) {
    for (const [key, value] of Object.entries(input.query)) {
      if (typeof value === "undefined") continue
      url.searchParams.set(key, String(value))
    }
  }

  const method = input.method ?? "GET"

  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.apiToken}`,
    ...(input.headers ?? {}),
  }

  let body: string | undefined = undefined
  if (typeof input.body !== "undefined") {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json"
    body = JSON.stringify(input.body)
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await withCloudflareGate(() =>
        fetch(url.toString(), {
          method,
          headers,
          body,
          signal: controller.signal,
        })
      )

      const text = await res.text().catch(() => "")
      const json = (() => {
        try {
          return text ? JSON.parse(text) : undefined
        } catch {
          return undefined
        }
      })()

      if (!res.ok) {
        const retryAfterMs = getRetryAfterMs(res, json)

        if (attempt < retries && isRetryableStatus(res.status)) {
          const base =
            res.status === 429
              ? Math.min(5_000 * 2 ** attempt, 60_000)
              : Math.min(250 * 2 ** attempt, 5_000)
          const jitter = Math.floor(Math.random() * 250)
          const delay = Math.max(base + jitter, retryAfterMs ?? 0)
          nextCloudflareAllowedAt = Math.max(nextCloudflareAllowedAt, Date.now() + delay)
          await sleep(delay)
          continue
        }
        throw new CloudflareApiError(
          extractCloudflareErrorMessage(json, "Cloudflare API request failed"),
          {
          status: res.status,
          payloadText: text,
          payloadJson: json,
          retryAfterMs,
          }
        )
      }

      return json as T
    } catch (error: unknown) {
      if (attempt < retries) {
        const retryableAbort =
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          (error as { name?: unknown }).name === "AbortError"
        if (retryableAbort) {
          const delay = Math.min(250 * 2 ** attempt, 2_500)
          await sleep(delay)
          continue
        }
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new Error("Unreachable: retries exhausted")
}
