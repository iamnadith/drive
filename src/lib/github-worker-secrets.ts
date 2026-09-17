import { createHash } from "node:crypto"

import { setGitHubActionsSecret } from "@/lib/github-oauth"
import { queryDb, withDbAdvisoryLock } from "@/lib/db"
import { setMigrationWorkerSecretSyncStatus } from "@/lib/migration-worker-settings-store"

const REPOSITORY_SYNC_CONCURRENCY = 4

export async function syncGitHubWorkerSecrets(input: {
  token: string
  owner: string
  repo: string
  serverUrl: string
  sharedSecret: string
  agentId?: string
  includeLegacyAgentId?: boolean
}) {
  const writes = [
    setGitHubActionsSecret({ token: input.token, owner: input.owner, repo: input.repo, name: "DRIVE_MIGRATION_ORCHESTRATOR_URL", value: input.serverUrl }),
    setGitHubActionsSecret({ token: input.token, owner: input.owner, repo: input.repo, name: "DRIVE_WORKER_SHARED_SECRET", value: input.sharedSecret }),
  ]
  if (input.includeLegacyAgentId && input.agentId) {
    writes.push(setGitHubActionsSecret({ token: input.token, owner: input.owner, repo: input.repo, name: "DRIVE_AGENT_ID", value: input.agentId }))
  }
  await Promise.all(writes)
}

export async function syncAllGitHubWorkerSecrets(input: {
  serverUrl: string
  sharedSecret: string
}) {
  const serverUrl = input.serverUrl.trim().replace(/\/+$/, "")
  const sharedSecret = input.sharedSecret.trim()
  if (!serverUrl) throw new Error("Migration Orchestrator URL is not configured")
  if (sharedSecret.length < 24 || sharedSecret.length > 512) {
    throw new Error("Migration Worker shared secret must be between 24 and 512 characters")
  }

  return withDbAdvisoryLock("github-worker-secret-sync", "all-repositories", async () => {
    await setMigrationWorkerSecretSyncStatus("syncing")
    try {
      const repositories = await queryDb<{
        owner: string
        repo: string
        token: string | null
      }>(`
        select distinct on (lower(github_repo_owner),lower(github_repo_name))
          github_repo_owner owner,github_repo_name repo,github_token token
        from drive_agents
        where provider='github_actions' and github_repo_owner is not null
          and github_repo_name is not null
        order by lower(github_repo_owner),lower(github_repo_name),updated_at desc,id
      `)

      for (let offset = 0; offset < repositories.rows.length; offset += REPOSITORY_SYNC_CONCURRENCY) {
        const batch = repositories.rows.slice(offset, offset + REPOSITORY_SYNC_CONCURRENCY)
        const results = await Promise.allSettled(batch.map(async (repository) => {
          try {
            if (!repository.token) throw new Error("saved GitHub authorization is missing; reconnect this workflow")
            await syncGitHubWorkerSecrets({
              token: repository.token,
              owner: repository.owner,
              repo: repository.repo,
              serverUrl,
              sharedSecret,
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`${repository.owner}/${repository.repo}: ${message}`)
          }
        }))
        const failures = results.flatMap((result) => result.status === "rejected" ? [String(result.reason instanceof Error ? result.reason.message : result.reason)] : [])
        if (failures.length) throw new Error(failures.join("; "))
      }

      await setMigrationWorkerSecretSyncStatus("ready", undefined, {
        serverUrl,
        secretHash: createHash("sha256").update(sharedSecret).digest("hex"),
      })
      return { syncedRepositories: repositories.rows.length }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await setMigrationWorkerSecretSyncStatus("failed", message).catch(() => undefined)
      throw error
    }
  })
}
