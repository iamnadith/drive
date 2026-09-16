import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/server-auth"
import {
  getMigrationWorkerSettings,
  publicMigrationWorkerSettings,
  saveMigrationWorkerSettings,
  setMigrationWorkerSecretSyncStatus,
} from "@/lib/migration-worker-settings-store"
import { getMigrationOrchestratorSettings } from "@/lib/migration-orchestrator-settings-store"
import { syncGitHubWorkerSecrets } from "@/lib/github-worker-secrets"
import { queryDb } from "@/lib/db"

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

    await setMigrationWorkerSecretSyncStatus("syncing")
    try {
      await saveMigrationWorkerSettings({ sharedSecret })
      const repositories = await queryDb<{
        owner: string
        repo: string
        token: string
      }>(`
        select distinct on (lower(github_repo_owner),lower(github_repo_name))
          github_repo_owner owner,github_repo_name repo,github_token token
        from drive_agents
        where provider='github_actions' and github_repo_owner is not null
          and github_repo_name is not null and github_token is not null and github_token<>''
        order by lower(github_repo_owner),lower(github_repo_name),updated_at desc,id
      `)
      if (repositories.rows.length) {
        const orchestration = await getMigrationOrchestratorSettings()
        const postgresUrl = String(process.env.POSTGRES_URL || "").trim()
        if (!orchestration.orchestratorUrl) throw new Error("Migration Orchestrator URL is not configured")
        if (!postgresUrl) throw new Error("POSTGRES_URL is not configured on the Drive server")
        await Promise.all(repositories.rows.map((repository) => syncGitHubWorkerSecrets({
          token: repository.token,
          owner: repository.owner,
          repo: repository.repo,
          serverUrl: orchestration.orchestratorUrl,
          sharedSecret,
          postgresUrl,
        })))
      }
      await setMigrationWorkerSecretSyncStatus("ready")
      const settings = await getMigrationWorkerSettings()
      return NextResponse.json({ settings: publicMigrationWorkerSettings(settings), syncedRepositories: repositories.rows.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await setMigrationWorkerSecretSyncStatus("failed", message).catch(() => undefined)
      return NextResponse.json({
        error: `The Worker secret was saved, but GitHub Actions credentials could not be synchronized. Dispatch is paused until synchronization succeeds. ${message}`,
        settings: publicMigrationWorkerSettings(await getMigrationWorkerSettings()),
      }, { status: 502 })
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}
