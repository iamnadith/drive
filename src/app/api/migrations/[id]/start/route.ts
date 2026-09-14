import { NextResponse } from "next/server"
import { getMigration, listMigrationItems, updateMigration } from "@/lib/migrations-store"
import { requireAdmin } from "@/lib/server-auth"
import { getMigrationReadOnlyState } from "@/lib/migration-read-only"
import { getMigrationOrchestratorSettings } from "@/lib/migration-orchestrator-settings-store"

export const runtime = "nodejs"

async function wakeMigrationOrchestrator(): Promise<void> {
  const settings = await getMigrationOrchestratorSettings()
  if (!settings.migrationEnabled || !settings.orchestratorUrl || settings.sharedSecret.length < 24) {
    throw new Error("Migration Orchestrator is not configured and enabled")
  }

  const response = await fetch(`${settings.orchestratorUrl.replace(/\/+$/, "")}/wake`, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.sharedSecret}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`Migration Orchestrator wake-up returned HTTP ${response.status}`)
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const migration = await getMigration(id)
    if (!migration) return NextResponse.json({ error: "Migration not found" }, { status: 404 })

    const readOnly = getMigrationReadOnlyState(migration)
    if (readOnly.readOnly) {
      return NextResponse.json({ error: `Migration history is read-only: ${readOnly.reason}` }, { status: 409 })
    }

    const startedAt = migration.startedAt ?? new Date().toISOString()
    await updateMigration(id, {
      status: "running",
      startedAt,
      completedAt: null,
      syncStatus: "syncing",
      syncMessage: "Queued for Migration Orchestrator",
      lastSyncedAt: new Date().toISOString(),
    })

    // This endpoint records the user's start command and wakes the durable
    // control plane. Bucket discovery/creation, scanning, copying, settings
    // sync, worker dispatch, and verification are performed by the workers.
    await wakeMigrationOrchestrator()

    return NextResponse.json({
      migration: await getMigration(id),
      items: await listMigrationItems(id),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unable to start migration"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
