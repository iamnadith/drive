import { setGitHubActionsSecret } from "@/lib/github-oauth"

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
