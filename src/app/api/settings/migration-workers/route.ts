import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/server-auth"
import {
  getMigrationWorkerSettings,
  publicMigrationWorkerSettings,
  saveMigrationWorkerSettings,
} from "@/lib/migration-worker-settings-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  const settings = await getMigrationWorkerSettings()
  return NextResponse.json(
    { settings: publicMigrationWorkerSettings(settings) },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  )
}

export async function PUT(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  try {
    const body = await request.json().catch(() => ({})) as { sharedSecret?: unknown }
    const settings = await saveMigrationWorkerSettings({ sharedSecret: body.sharedSecret })
    return NextResponse.json({ settings: publicMigrationWorkerSettings(settings) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}
