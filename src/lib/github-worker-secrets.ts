import { createHash } from "node:crypto"

import { withDbAdvisoryLock } from "@/lib/db"
import { setMigrationWorkerSecretSyncStatus } from "@/lib/migration-worker-settings-store"

function validateDispatchConfiguration(input: {
  token: string
  owner: string
  repo: string
  serverUrl: string
  sharedSecret: string
}) {
  if (!input.serverUrl.trim()) throw new Error("Migration Orchestrator URL is not configured")
  if (input.sharedSecret.trim().length < 24 || input.sharedSecret.trim().length > 512) {
    throw new Error("Migration Worker shared secret must be between 24 and 512 characters")
  }
}

// Worker credentials travel with each repository_dispatch event so shared
// worker repositories never need deployment-specific GitHub Actions secrets.
export function validateGitHubWorkerDispatchConfiguration(input: {
  token: string
  owner: string
  repo: string
  serverUrl: string
  sharedSecret: string
  agentId?: string
  includeLegacyAgentId?: boolean
}) {
  validateDispatchConfiguration(input)
}

export async function markGitHubWorkerDispatchConfigurationReady(input: {
  serverUrl: string
  sharedSecret: string
}) {
  return withDbAdvisoryLock("github-worker-dispatch-config", "current-deployment", () =>
    markGitHubWorkerDispatchConfigurationReadyWithinInstallerLock(input)
  )
}

// The Cloudflare installer already holds its own installation-wide advisory
// lock. Acquiring another lock through the dedicated one-connection lock pool
// would deadlock until pg.Pool's connection timeout. Keep this validation
// reusable without nesting a second database lock.
export async function markGitHubWorkerDispatchConfigurationReadyWithinInstallerLock(input: {
  serverUrl: string
  sharedSecret: string
}) {
  const serverUrl = input.serverUrl.trim().replace(/\/+$/, "")
  const sharedSecret = input.sharedSecret.trim()
  validateDispatchConfiguration({ token: "", owner: "", repo: "", serverUrl, sharedSecret })

  await setMigrationWorkerSecretSyncStatus("syncing")
  try {
    await setMigrationWorkerSecretSyncStatus("ready", undefined, {
      serverUrl,
      secretHash: createHash("sha256").update(sharedSecret).digest("hex"),
    })
    return { delivery: "repository_dispatch_payload" as const }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await setMigrationWorkerSecretSyncStatus("failed", message).catch(() => undefined)
    throw error
  }
}
