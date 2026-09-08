import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/server-auth"
import {
  getMigrationOrchestratorSettings,
  publicMigrationOrchestratorSettings,
  saveMigrationOrchestratorSettings,
} from "@/lib/migration-orchestrator-settings-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function callWorker(settings: Awaited<ReturnType<typeof getMigrationOrchestratorSettings>>, worker: "migration" | "file", path: string, method: "GET" | "POST") {
  const baseUrl = worker === "migration" ? settings.orchestratorUrl : settings.fileScannerUrl
  const workerSecret = settings.sharedSecret
  if (!baseUrl || workerSecret.length < 24 || workerSecret.length > 512) {
    throw new Error(`Save the ${worker === "migration" ? "Migration Orchestrator" : "File Scanner"} URL and secret first`)
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${workerSecret}` },
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
  const [worker, fileScanner] = await Promise.all([
    settings.orchestratorUrl && settings.sharedSecret.length >= 24 ? callWorker(settings, "migration", "/status", "GET").catch(() => null) : null,
    settings.fileScannerUrl && settings.sharedSecret.length >= 24 ? callWorker(settings, "file", "/status", "GET").catch(() => null) : null,
  ])
  return NextResponse.json({ settings: publicMigrationOrchestratorSettings(settings), worker, fileScanner }, { headers: { "Cache-Control": "no-store, max-age=0" } })
}

export async function PUT(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  try {
    const body = await request.json().catch(() => ({})) as { orchestratorUrl?: unknown; fileScannerUrl?: unknown; sharedSecret?: unknown }
    // Saving connection details must not implicitly disable an already-enabled setup.
    const settings = await saveMigrationOrchestratorSettings({ orchestratorUrl: body.orchestratorUrl, fileScannerUrl: body.fileScannerUrl, sharedSecret: body.sharedSecret })
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
    if (body.enabled) await Promise.all([callWorker(current, "migration", "/status", "GET"), callWorker(current, "file", "/status", "GET")])
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
    const action = body.action === "test" ? "test" : body.action === "run_file" ? "run_file" : "run"
    const settings = await getMigrationOrchestratorSettings()
    if (action !== "test" && !settings.enabled) throw new Error("Enable orchestration before running it")
    const result = action === "test"
      ? await Promise.all([callWorker(settings, "migration", "/status", "GET"), callWorker(settings, "file", "/status", "GET")])
      : await callWorker(settings, action === "run_file" ? "file" : "migration", "/run", "POST")
    return NextResponse.json({ ok: true, action, result })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}
