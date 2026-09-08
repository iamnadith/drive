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
  const workerSecret = worker === "migration" ? settings.sharedSecret : settings.fileScannerSecret
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
  if (!response.ok) {
    const label = worker === "migration" ? "Migration Orchestrator" : "File Scanner"
    throw new Error(`${label} rejected the request (HTTP ${response.status}): ${payload.error || "Unauthorized"}`)
  }
  return payload
}

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  const settings = await getMigrationOrchestratorSettings()
  const [worker, fileScanner] = await Promise.all([
    settings.orchestratorUrl && settings.sharedSecret.length >= 24 ? callWorker(settings, "migration", "/status", "GET").catch(() => null) : null,
    settings.fileScannerUrl && settings.fileScannerSecret.length >= 24 ? callWorker(settings, "file", "/status", "GET").catch(() => null) : null,
  ])
  return NextResponse.json({ settings: publicMigrationOrchestratorSettings(settings), worker, fileScanner }, { headers: { "Cache-Control": "no-store, max-age=0" } })
}

export async function PUT(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  try {
    const body = await request.json().catch(() => ({})) as { worker?: unknown; orchestratorUrl?: unknown; fileScannerUrl?: unknown; sharedSecret?: unknown; fileScannerSecret?: unknown }
    // Saving connection details must preserve the current enabled state.
    const settings = await saveMigrationOrchestratorSettings(body.worker === "file"
      ? { fileScannerUrl: body.fileScannerUrl, fileScannerSecret: body.fileScannerSecret }
      : { orchestratorUrl: body.orchestratorUrl, sharedSecret: body.sharedSecret })
    return NextResponse.json({ settings: publicMigrationOrchestratorSettings(settings) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  try {
    const body = await request.json().catch(() => ({})) as { enabled?: unknown; worker?: unknown }
    if (typeof body.enabled !== "boolean") throw new Error("Enabled must be true or false")
    if (body.worker !== "migration" && body.worker !== "file") throw new Error("Worker must be migration or file")
    const current = await getMigrationOrchestratorSettings()
    const worker = body.worker as "migration" | "file"
    if (body.enabled) await callWorker(current, worker, "/status", "GET")
    const settings = await saveMigrationOrchestratorSettings(worker === "migration" ? { migrationEnabled: body.enabled } : { fileScannerEnabled: body.enabled })
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
    const action = body.action === "test_file" ? "test_file" : body.action === "test_migration" ? "test_migration" : body.action === "test" ? "test" : body.action === "run_file" ? "run_file" : "run"
    const settings = await getMigrationOrchestratorSettings()
    if (action !== "test" && action !== "test_file" && action !== "test_migration" && ((action === "run_file" && !settings.fileScannerEnabled) || (action === "run" && !settings.migrationEnabled))) throw new Error(`Enable the ${action === "run_file" ? "File Scanner" : "Migration Orchestrator"} before running it`)
    const result = action === "test_file"
      ? await callWorker(settings, "file", "/status", "GET")
      : action === "test_migration"
        ? await callWorker(settings, "migration", "/status", "GET")
        : action === "test"
          ? await Promise.all([callWorker(settings, "migration", "/status", "GET"), callWorker(settings, "file", "/status", "GET")])
      : await callWorker(settings, action === "run_file" ? "file" : "migration", "/run", "POST")
    return NextResponse.json({ ok: true, action, result })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}
