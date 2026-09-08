type Env = {
  PANEL_URL?: string
  PANEL_SHARED_SECRET?: string
}

type CycleResult = {
  ok: boolean
  status: number
  payload: unknown
  startedAt: string
  completedAt: string
}

const BUILD = 1
const REQUEST_TIMEOUT_MS = 25_000
const MIN_SECRET_LENGTH = 24
// Keep attacker-controlled authentication work bounded on the Workers Free
// CPU budget. Panel-generated secrets are far shorter than this limit.
const MAX_SECRET_LENGTH = 512
let inFlight: Promise<CycleResult> | null = null
let runtimeState: {
  status: "idle" | "running" | "error"
  lastStartedAt?: string
  lastCompletedAt?: string
  lastError?: string
  lastResult?: unknown
} = { status: "idle" }

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store, max-age=0" } })
}

function panelUrl(env: Env): string {
  const value = String(env.PANEL_URL ?? "").trim()
  if (!value) throw new Error("PANEL_URL is not configured")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("PANEL_URL must be an absolute HTTP(S) URL")
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("PANEL_URL must use HTTPS (HTTP is allowed only for localhost development)")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("PANEL_URL must not contain credentials, a query string, or a fragment")
  }
  return url.toString().replace(/\/+$/, "")
}

function sharedSecret(env: Env): string {
  const value = String(env.PANEL_SHARED_SECRET ?? "").trim()
  if (value.length < MIN_SECRET_LENGTH) throw new Error(`PANEL_SHARED_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
  if (value.length > MAX_SECRET_LENGTH) throw new Error(`PANEL_SHARED_SECRET must be at most ${MAX_SECRET_LENGTH} characters`)
  return value
}

function recordPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : { result: payload }
}

async function safeEqual(left: string, right: string): Promise<boolean> {
  if (left.length > MAX_SECRET_LENGTH || right.length > MAX_SECRET_LENGTH) return false
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  let mismatch = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0)
  return mismatch === 0
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") ?? ""
  if (!header.toLowerCase().startsWith("bearer ")) return false
  if (header.length > MAX_SECRET_LENGTH + 16) return false
  try {
    return await safeEqual(header.slice(7).trim(), sharedSecret(env))
  } catch {
    return false
  }
}

async function runCycle(env: Env): Promise<CycleResult> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const startedAt = new Date().toISOString()
    runtimeState = { status: "running", lastStartedAt: startedAt, lastResult: runtimeState.lastResult }
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      let response: Response
      try {
        response = await fetch(`${panelUrl(env)}/api/internal/migration-orchestrator/tick`, {
          method: "POST",
          headers: { Authorization: `Bearer ${sharedSecret(env)}`, Accept: "application/json" },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }
      const payload = await response.json().catch(() => ({}))
      const completedAt = new Date().toISOString()
      const result: CycleResult = { ok: response.ok, status: response.status, payload, startedAt, completedAt }
      runtimeState = {
        status: response.ok ? "idle" : "error",
        lastStartedAt: startedAt,
        lastCompletedAt: completedAt,
        lastError: response.ok ? undefined : String((payload as { error?: unknown })?.error ?? `Panel returned HTTP ${response.status}`),
        lastResult: payload,
      }
      return result
    } catch (error) {
      const completedAt = new Date().toISOString()
      const message = error instanceof Error ? error.message : String(error)
      const result: CycleResult = { ok: false, status: 503, payload: { error: message }, startedAt, completedAt }
      runtimeState = { status: "error", lastStartedAt: startedAt, lastCompletedAt: completedAt, lastError: message, lastResult: result.payload }
      return result
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ ok: true, service: "migration-orchestrator", build: BUILD })
    }
    if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401)
    if (url.pathname === "/status" && request.method === "GET") {
      return json({ ok: true, service: "migration-orchestrator", build: BUILD, ...runtimeState })
    }
    if (url.pathname === "/run" && request.method === "POST") {
      const result = await runCycle(env)
      return json({ ...recordPayload(result.payload), orchestrator: { build: BUILD, ...runtimeState } }, result.status)
    }
    return json({ error: "Not found" }, 404)
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCycle(env).then(() => undefined))
  },
}
