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

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  const settings = await getBackendOrchestratorSettings()
  return NextResponse.json({ settings: publicBackendOrchestratorSettings(settings), state: await state() })
}

export async function PUT(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  try {
    const saved = await saveBackendOrchestratorSettings(await request.json())
    return NextResponse.json({ settings: publicBackendOrchestratorSettings(saved), state: await state() })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}

export async function POST() {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  const settings = await getBackendOrchestratorSettings()
  if (!settings.enabled || !settings.orchestratorUrl || !settings.sharedSecret) {
    return NextResponse.json({ error: "Save and enable Backend Orchestrator settings first" }, { status: 400 })
  }
  try {
    const response = await fetch(`${settings.orchestratorUrl}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.sharedSecret}` },
      signal: AbortSignal.timeout(30_000),
    })
    const payload = await response.json().catch(() => ({}))
    return NextResponse.json(payload, { status: response.status })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}
