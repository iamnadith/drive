const WORKER_DIRECTORY = "workers/migration-worker"

export function isWorkerWorkflow(content: string): boolean {
  const hasCurrentBootstrapSecrets =
    content.includes("DRIVE_MIGRATION_ORCHESTRATOR_URL") &&
    content.includes("DRIVE_WORKER_SHARED_SECRET")

  return /^\s*repository_dispatch\s*:/m.test(content) &&
    content.includes("drive-migration-worker") &&
    content.includes("github.event.client_payload") &&
    hasCurrentBootstrapSecrets &&
    content.includes(WORKER_DIRECTORY)
}
