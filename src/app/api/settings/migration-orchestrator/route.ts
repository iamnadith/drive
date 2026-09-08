import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/server-auth"
import {
  getMigrationOrchestratorSettings,
  publicMigrationOrchestratorSettings,
  saveMigrationOrchestratorSettings,
} from "@/lib/migration-orchestrator-settings-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function callWorker(settings: Awaited<ReturnType<typeof getMigrationOrchestratorSettings>>, path: string, method: "GET" | "POST") {
  if (!settings.orchestratorUrl || settings.sharedSecret.length < 24 || settings.sharedSecret.length > 512) {
    throw new Error("Save the Migration Orchestrator URL and a shared secret between 24 and 512 characters first")
  }
  const response = await fetch(`${settings.orchestratorUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${settings.sharedSecret}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(payload.error || `Migration Orchestrator returned HTTP ${response.status}`)
  return payload
}

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  const settings = await getMigrationOrchestratorSettings()
  const worker = settings.orchestratorUrl && settings.sharedSecret.length >= 24
    ? await callWorker(settings, "/status", "GET").catch(() => null)
    : null
  return NextResponse.json({ settings: publicMigrationOrchestratorSettings(settings), worker }, { headers: { "Cache-Control": "no-store, max-age=0" } })
}

export async function PUT(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  try {
    const body = await request.json().catch(() => ({})) as { orchestratorUrl?: unknown; sharedSecret?: unknown }
    const settings = await saveMigrationOrchestratorSettings({ enabled: false, orchestratorUrl: body.orchestratorUrl, sharedSecret: body.sharedSecret })
    return NextResponse.json({ settings: publicMigrationOrchestratorSettings(settings) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  try {
    const body = await request.json().catch(() => ({})) as { enabled?: unknown }
    if (typeof body.enabled !== "boolean") throw new Error("Enabled must be true or false")
    const current = await getMigrationOrchestratorSettings()
    if (body.enabled) await callWorker(current, "/status", "GET")
    const settings = await saveMigrationOrchestratorSettings({ enabled: body.enabled })
    return NextResponse.json({ settings: publicMigrationOrchestratorSettings(settings) })
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
    const settings = await getMigrationOrchestratorSettings()
    if (action === "run" && !settings.enabled) throw new Error("Enable the Migration Orchestrator before running it")
    const result = await callWorker(settings, action === "test" ? "/status" : "/run", action === "test" ? "GET" : "POST")
    return NextResponse.json({ ok: true, action, result })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}
