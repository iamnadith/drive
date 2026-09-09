const WORKER_DIRECTORY = "workers/migration-worker"

export function isWorkerWorkflow(content: string): boolean {
  const hasDispatchInputs = ["migration_id", "repair_job_id", "agent_id", "worker_instance_id"].every((key) =>
    new RegExp(`^\\s*${key}\\s*:`, "m").test(content)
  )
  const hasCurrentBootstrapSecrets =
    content.includes("DRIVE_MIGRATION_ORCHESTRATOR_URL") &&
    content.includes("DRIVE_WORKER_SHARED_SECRET")

  return /^\s*workflow_dispatch\s*:/m.test(content) &&
    hasDispatchInputs &&
    hasCurrentBootstrapSecrets &&
    content.includes(WORKER_DIRECTORY)
}
