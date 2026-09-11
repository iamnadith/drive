import { queryDb } from "./db"

export type MigrationWorkerRun = {
  id: string
  jobId?: string
  agentId: string
  status: string
  online: boolean
  externalRunId?: string
  instanceId?: string
  currentFile?: Record<string, unknown>
  currentStatus?: string
  lastHeartbeatAt?: string
  completedFiles: number
  failedFiles: number
  completedBytes: number
  createdAt: string
  updatedAt: string
}

type RunRow = {
  id: string
  job_reference: string | null
  agent_id: string
  status: string
  online: boolean
  external_run_id: string | null
  instance_id: string | null
  job_status: string | null
  job_payload: Record<string, unknown> | null
  job_progress: Record<string, unknown> | null
  job_heartbeat: string | null
  completed_files: string | number
  failed_files: string | number
  completed_bytes: string | number
  created_at: string
  updated_at: string
}

export async function listMigrationWorkerRuns(migrationId: string): Promise<MigrationWorkerRun[]> {
  const result = await queryDb<RunRow>(`
    select r.id,r.job_reference,r.agent_id,r.status,r.external_run_id,r.payload->>'workerInstanceId' instance_id,
      (r.status='running' and a.status='online' and a.last_heartbeat_at>now()-interval '90 seconds') online,
      j.status job_status,j.payload job_payload,j.progress job_progress,j.last_heartbeat_at job_heartbeat,
      coalesce((r.payload->>'completedFiles')::bigint,0) completed_files,
      coalesce((r.payload->>'failedFiles')::bigint,0) failed_files,
      coalesce((r.payload->>'completedBytes')::bigint,0) completed_bytes,r.created_at,r.updated_at
    from drive_agent_runs r
    left join drive_agents a on a.id=r.agent_id
    -- job_reference is legacy text while repair job ids are uuid. Compare
    -- using the uuid's text representation so the projection cannot fail on
    -- non-UUID/legacy references (the API previously swallowed this error
    -- and rendered an empty worker list).
    left join drive_repair_jobs j on j.id::text=r.job_reference
    where r.run_type='github_dispatch' and r.payload->>'migrationId'=$1
    order by r.created_at
    limit 100
  `, [migrationId])
  return result.rows.map((row) => {
    const progress = row.job_progress && typeof row.job_progress === "object" ? row.job_progress : {}
    const payload = row.job_payload && typeof row.job_payload === "object" ? row.job_payload : {}
    const currentFile = progress.currentFile && typeof progress.currentFile === "object"
      ? progress.currentFile as Record<string, unknown>
      : Array.isArray(payload.inventoryObjects) && payload.inventoryObjects[0] && typeof payload.inventoryObjects[0] === "object"
        ? payload.inventoryObjects[0] as Record<string, unknown>
        : undefined
    return {
      id: row.id,
      jobId: row.job_reference ?? undefined,
      agentId: row.agent_id,
      status: row.status,
      online: row.online === true,
      externalRunId: row.external_run_id ?? undefined,
      instanceId: row.instance_id ?? undefined,
      currentFile,
      currentStatus: row.job_status ?? undefined,
      lastHeartbeatAt: row.job_heartbeat ?? undefined,
      completedFiles: Number(row.completed_files) || 0,
      failedFiles: Number(row.failed_files) || 0,
      completedBytes: Number(row.completed_bytes) || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  })
}
