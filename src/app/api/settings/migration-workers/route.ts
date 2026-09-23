import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/server-auth"
import { recordUserActivity } from "@/lib/activity-audit"
import {
  getMigrationWorkerSettings,
  publicMigrationWorkerSettings,
  saveMigrationWorkerSettings,
} from "@/lib/migration-worker-settings-store"
import { getMigrationOrchestratorSettings } from "@/lib/migration-orchestrator-settings-store"
import { syncAllGitHubWorkerSecrets } from "@/lib/github-worker-secrets"

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
    const current = await getMigrationWorkerSettings()
    const requested = typeof body.sharedSecret === "string" ? body.sharedSecret.trim() : ""
    const sharedSecret = requested || current.sharedSecret
    if (sharedSecret.length < 24 || sharedSecret.length > 512) {
      throw new Error("Migration Worker shared secret must be between 24 and 512 characters")
    }

    try {
      await saveMigrationWorkerSettings({ sharedSecret })
      const orchestration = await getMigrationOrchestratorSettings()
      const synchronization = await syncAllGitHubWorkerSecrets({
        serverUrl: orchestration.orchestratorUrl,
        sharedSecret,
      })
      const settings = await getMigrationWorkerSettings()
      await recordUserActivity(request, auth.user.id, {
        action: "settings.migration_workers.secret_updated", entityType: "settings", entityId: "migration-workers",
        entityLabel: "Migration Worker credentials", summary: "Updated Migration Worker credentials",
        after: { configured: true, syncedRepositories: synchronization.syncedRepositories },
      })
      return NextResponse.json({ settings: publicMigrationWorkerSettings(settings), syncedRepositories: synchronization.syncedRepositories })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return NextResponse.json({
        error: `The Worker secret was saved, but GitHub Actions credentials could not be synchronized. Dispatch is paused until synchronization succeeds. ${message}`,
        settings: publicMigrationWorkerSettings(await getMigrationWorkerSettings()),
      }, { status: 502 })
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}
