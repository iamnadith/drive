import { NextResponse } from "next/server"
import { isPostgresConfigured, queryDb } from "@/lib/db"
import {
  getBackendOrchestratorSettings,
  publicBackendOrchestratorSettings,
  saveBackendOrchestratorSettings,
} from "@/lib/backend-orchestrator-settings-store"
import { requireAdmin } from "@/lib/server-auth"
import { recordUserActivity } from "@/lib/activity-audit"
import { scheduleWorkerRepair, workerFailureResponse } from "@/lib/worker-failure-response"

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
  let worker: unknown = null
  let workerFailed = false
  if (settings.orchestratorUrl && settings.sharedSecret) {
    try { worker = await callOrchestrator(settings, { path: "/status", method: "GET" }) }
    catch { workerFailed = true; scheduleWorkerRepair() }
  }
  return NextResponse.json(
    { settings: publicBackendOrchestratorSettings(settings), state: await state(), worker },
    { headers: { "Cache-Control": "no-store, max-age=0", ...(workerFailed ? { "X-Drive-Worker-Failure": "1" } : {}) } }
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
    }
    const saved = await saveBackendOrchestratorSettings({
      enabled: false,
      orchestratorUrl: body.orchestratorUrl,
      sharedSecret: body.sharedSecret,
      syncIntervalMinutes: body.syncIntervalMinutes,
    })
    await recordUserActivity(request, auth.user.id, {
      action: "settings.backend_orchestrator.updated", entityType: "settings", entityId: "backend-orchestrator",
      entityLabel: "Backend Orchestrator", summary: "Updated Backend Orchestrator connection settings",
      after: { configured: Boolean(saved.orchestratorUrl), syncIntervalMinutes: saved.syncIntervalMinutes },
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
    await recordUserActivity(request, auth.user.id, {
      action: `settings.backend_orchestrator.${body.enabled ? "enabled" : "disabled"}`,
      entityType: "settings", entityId: "backend-orchestrator", entityLabel: "Backend Orchestrator",
      summary: `${body.enabled ? "Enabled" : "Disabled"} Backend Orchestrator`,
      before: { enabled: current.enabled }, after: { enabled: body.enabled },
    })
    return NextResponse.json({ settings: publicBackendOrchestratorSettings(saved), state: await state() })
  } catch (error) {
    return workerFailureResponse(error)
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
    await recordUserActivity(request, auth.user.id, {
      action: action === "test" ? "backend_orchestrator.connection_tested" : "backend_orchestrator.run_requested",
      entityType: "backend_orchestrator", entityId: "backend-orchestrator",
      entityLabel: "Backend Orchestrator", summary: action === "test" ? "Tested Backend Orchestrator connection" : "Requested Backend Orchestrator run",
    })
    return NextResponse.json({ ok: true, action, result: payload, state: await state() })
  } catch (error) {
    return workerFailureResponse(error)
  }
}
