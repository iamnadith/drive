import { NextResponse } from "next/server"
import { isPostgresConfigured, queryDb } from "@/lib/db"
import {
  getBackendOrchestratorSettings,
  publicBackendOrchestratorSettings,
  saveBackendOrchestratorSettings,
} from "@/lib/backend-orchestrator-settings-store"
import { requireAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function state() {
  if (!isPostgresConfigured()) return null
  const { rows } = await queryDb(`select * from drive_backend_orchestrator_state where id = true limit 1`).catch(() => ({ rows: [] }))
  return rows[0] ?? null
}

async function callOrchestrator(
  settings: Awaited<ReturnType<typeof getBackendOrchestratorSettings>>,
  input: { path: string; method: "GET" | "POST" }
) {
  if (!settings.orchestratorUrl || !settings.sharedSecret) {
    throw new Error("Save the Backend Orchestrator URL and shared secret first")
  }
  const response = await fetch(`${settings.orchestratorUrl}${input.path}`, {
    method: input.method,
    headers: { Authorization: `Bearer ${settings.sharedSecret}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(payload.error || `Backend Orchestrator returned HTTP ${response.status}`)
  return payload
}

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  const settings = await getBackendOrchestratorSettings()
  return NextResponse.json(
    { settings: publicBackendOrchestratorSettings(settings), state: await state() },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  )
}

export async function PUT(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  try {
    const body = await request.json() as {
      orchestratorUrl?: unknown
      sharedSecret?: unknown
      syncIntervalMinutes?: unknown
      pagesPerRun?: unknown
    }
    const saved = await saveBackendOrchestratorSettings({
      enabled: false,
      orchestratorUrl: body.orchestratorUrl,
      sharedSecret: body.sharedSecret,
      syncIntervalMinutes: body.syncIntervalMinutes,
      pagesPerRun: body.pagesPerRun,
    })
    return NextResponse.json({ settings: publicBackendOrchestratorSettings(saved), state: await state() })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  try {
    const body = await request.json() as { enabled?: unknown }
    if (typeof body.enabled !== "boolean") throw new Error("Enabled must be true or false")
    const current = await getBackendOrchestratorSettings()
    if (body.enabled) await callOrchestrator(current, { path: "/status", method: "GET" })
    const saved = await saveBackendOrchestratorSettings({ enabled: body.enabled })
    return NextResponse.json({ settings: publicBackendOrchestratorSettings(saved), state: await state() })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  try {
    const body = await request.json().catch(() => ({})) as { action?: unknown }
    const action = body.action === "test" ? "test" : "run"
    const settings = await getBackendOrchestratorSettings()
    if (action === "run" && !settings.enabled) throw new Error("Enable the Backend Orchestrator before running it")
    const payload = await callOrchestrator(settings, {
      path: action === "test" ? "/status" : "/run",
      method: action === "test" ? "GET" : "POST",
    })
    return NextResponse.json({ ok: true, action, result: payload, state: await state() })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}
