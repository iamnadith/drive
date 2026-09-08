import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createAgentRun, getAgentById, getAgentGithubToken, listAgentRunsByAgentId, updateAgent, updateAgentRun } from "@/lib/agents-store"
import { abortRepairJob, createRepairJob, ensureMigrationWorkerJobs, findActiveRepairJobForDispatch, listRepairJobs, type RepairJobMode } from "@/lib/repair-jobs-store"
import { GITHUB_TOKEN_COOKIE, listGitHubWorkflowRuns, setGitHubActionsSecret } from "@/lib/github-oauth"
import { enrollMigrationWorkerAgent, getMigration, listMigrationItems } from "@/lib/migrations-store"
import { queryDb } from "@/lib/db"
import { getMigrationWorkerSharedSecret } from "@/lib/migration-worker-settings-store"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function normalizeStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase()
}

function hasActiveSuperSlurper(items: Array<{ slurperJobId?: string; slurperStatus?: string | null }>): boolean {
  const activeStatuses = new Set(["queued", "pending", "creating_job", "job_id_pending", "running", "scanning", "verifying"])
  return items.some((item) => {
    const status = normalizeStatus(item.slurperStatus)
    return activeStatuses.has(status)
  })
}

function getGitHubTokenFallback(): string {
  return (
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  ).trim()
}

async function syncGitHubWorkerSecrets(input: {
  token: string
  owner: string
  repo: string
  serverUrl: string
  sharedSecret: string
  agentId?: string
  includeLegacyAgentId?: boolean
}) {
  const writes = [
    setGitHubActionsSecret({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      name: "DRIVE_SERVER_URL",
      value: input.serverUrl,
    }),
    setGitHubActionsSecret({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      name: "DRIVE_WORKER_SHARED_SECRET",
      value: input.sharedSecret,
    }),
  ]
  if (input.includeLegacyAgentId && input.agentId) {
    writes.push(setGitHubActionsSecret({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      name: "DRIVE_AGENT_ID",
      value: input.agentId,
    }))
  }
  await Promise.all(writes)
}

function isUnexpectedWorkflowInputsError(status: number, text: string): boolean {
  return status === 422 && /unexpected inputs provided/i.test(text)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecentIso(value: string | undefined, maxAgeMs: number): boolean {
  if (!value) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && Date.now() - time <= maxAgeMs
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const agent = await getAgentById(id)
    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 })

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const migrationId = typeof body.migrationId === "string" ? body.migrationId.trim() : ""
    const mode = (
      typeof body.mode === "string" && ["verify_only", "repair_only", "repair_and_verify"].includes(body.mode)
        ? body.mode
        : "repair_and_verify"
    ) as RepairJobMode
    const dispatchInputs =
      typeof body.inputs === "object" && body.inputs !== null ? (body.inputs as Record<string, unknown>) : {}
    const workflowSupportsRuntimeInputs = body.workflowSupportsRuntimeInputs !== false

    if (!migrationId) return NextResponse.json({ error: "migrationId is required" }, { status: 400 })
    const migration = await getMigration(migrationId)
    if (!migration) return NextResponse.json({ error: "Migration not found" }, { status: 404 })
    const items = await listMigrationItems(migrationId)
    const pool = body.pool === true || migration.options.executionMode === "migration_workers"
    if (body.pool === true && migration.options.executionMode !== "migration_workers") {
      return NextResponse.json({ error: "Worker pool dispatch requires a migration created with the worker engine" }, { status: 409 })
    }
    if (pool && !["running", "verifying"].includes(migration.status)) {
      return NextResponse.json({ error: "Start the migration before dispatching its worker pool" }, { status: 409 })
    }
    if (pool && !agent.capabilities.includes("bulk_migrate")) {
      return NextResponse.json(
        { error: "This worker is not registered for full migrations. Update the worker runtime and wait for its heartbeat before dispatching a worker-pool migration." },
        { status: 409 }
      )
    }
    if (migration.options.executionMode !== "migration_workers" && hasActiveSuperSlurper(items)) {
      return NextResponse.json({ error: "Cannot run with worker while Super Slurper is still active for this migration." }, { status: 409 })
    }
    if (!pool) {
      const existingJob = await findActiveRepairJobForDispatch({
        migrationId,
        requestedByAgentId: id,
      })
      if (existingJob) {
        return NextResponse.json(
          { error: `A worker job is already active for this migration on this worker (${existingJob.id}).`, job: existingJob },
          { status: 409 }
        )
      }
    }

    if (agent.provider !== "github_actions") {
      if (
        (agent.provider === "self_hosted" || agent.provider === "local") &&
        (agent.status !== "online" || !isRecentIso(agent.lastHeartbeatAt, 60_000))
      ) {
        return NextResponse.json(
          { error: "Selected self-hosted worker is offline. Start the worker before dispatching this job." },
          { status: 409 }
        )
      }
      if (pool) {
        const activePoolJob = (await listRepairJobs(500)).find(
          (job) => job.claimedByAgentId === id && ["pending", "claimed", "running"].includes(job.status)
        )
        if (activePoolJob) {
          return NextResponse.json(
            { error: `This worker already owns active pool shard ${activePoolJob.id}.`, job: activePoolJob },
            { status: 409 }
          )
        }
      }
      const queued = pool
        ? await ensureMigrationWorkerJobs({ migrationId, mode })
        : null
      const job = pool
        ? null
        : await createRepairJob({
            migrationId,
            mode,
            requestedByAgentId: id,
            payload: { source: agent.provider, agentId: id },
          })

      await updateAgent(id, {
        status: agent.provider === "self_hosted" || agent.provider === "local" ? "online" : agent.status,
        lastError: null,
        metadata: {
          ...(agent.metadata ?? {}),
          activeRepairJobId: job?.id ?? null,
          ...(pool ? { activeMigrationId: migrationId } : { activeMigrationId: null }),
        },
      }).catch(() => undefined)

      return NextResponse.json({ ok: true, job, jobs: queued?.jobs ?? [] }, { status: 200 })
    }

    if (!agent.githubRepoOwner || !agent.githubRepoName || !agent.githubWorkflowFile) {
      return NextResponse.json({ error: "GitHub repo owner, repo name, and workflow file are required" }, { status: 400 })
    }
    const githubRepoOwner = agent.githubRepoOwner
    const githubRepoName = agent.githubRepoName
    const githubWorkflowFile = agent.githubWorkflowFile

    const workerJobs = await listRepairJobs(500)
    const activeWorkerJobs = workerJobs.filter(
      (job) =>
        !["completed", "failed", "canceled"].includes(job.status) &&
        (job.claimedByAgentId === id || (!pool && job.requestedByAgentId === id))
    )
    if (activeWorkerJobs.length > 0) {
      return NextResponse.json(
        {
          error: `This worker already has ${activeWorkerJobs.length} active repair job(s). Stop or abort them before dispatching another workflow.`,
          jobs: activeWorkerJobs,
        },
        { status: 409 }
      )
    }

    const activeWorkerRuns = await listAgentRunsByAgentId(id, 20)
    const workerJobStatusById = new Map(workerJobs.map((job) => [job.id, job.status]))
    const activeDispatchRuns = activeWorkerRuns.filter(
      (run) =>
        run.runType === "github_dispatch" &&
        (run.status === "pending" || run.status === "running") &&
        (!run.jobReference || !["completed", "failed", "canceled"].includes(workerJobStatusById.get(run.jobReference) ?? ""))
    )
    if (activeDispatchRuns.length > 0) {
      return NextResponse.json(
        {
          error: `This worker already has ${activeDispatchRuns.length} active GitHub workflow run(s). Stop the worker before dispatching again.`,
          runs: activeDispatchRuns,
        },
        { status: 409 }
      )
    }

    const githubToken = (await getAgentGithubToken(id)) || (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value || getGitHubTokenFallback()
    if (!githubToken) {
      return NextResponse.json(
        { error: "No GitHub token available. Save one on the agent or set GITHUB_TOKEN on the server." },
        { status: 400 }
      )
    }

    const sharedSecret = await getMigrationWorkerSharedSecret()
    if (sharedSecret.length < 24 || sharedSecret.length > 512) {
      return NextResponse.json(
        { error: "Configure a Migration Worker shared secret between 24 and 512 characters in Settings before dispatching a GitHub worker." },
        { status: 409 }
      )
    }

    const serverUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || new URL(request.url).origin).replace(/\/+$/, "")
    const postgresUrl = (process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || "").trim()
    if (!postgresUrl) {
      return NextResponse.json(
        { error: "PostgreSQL URL is required for autonomous worker recovery" },
        { status: 503 }
      )
    }
    await queryDb(
      `insert into drive_app_settings(key,value,updated_at) values('orchestration-panel-origin',$1::jsonb,now()) on conflict(key) do update set value=excluded.value,updated_at=now()`,
      [JSON.stringify({ panelOrigin: serverUrl })]
    )
    const dispatchRequestedAt = new Date().toISOString()
    const runsBeforeDispatch = await listGitHubWorkflowRuns({
      token: githubToken,
      owner: githubRepoOwner,
      repo: githubRepoName,
      workflow: githubWorkflowFile,
      branch: agent.githubRef || "main",
      event: "workflow_dispatch",
      perPage: 20,
    }).catch(() => [])
    const runIdsBeforeDispatch = new Set(runsBeforeDispatch.map((candidate) => candidate.id))
    let secretSyncError: string | null = null
    try {
      if (!workflowSupportsRuntimeInputs) {
        await syncGitHubWorkerSecrets({ token: githubToken, owner: githubRepoOwner, repo: githubRepoName, serverUrl, sharedSecret, agentId: id, includeLegacyAgentId: true })
      }
      await setGitHubActionsSecret({ token: githubToken, owner: githubRepoOwner, repo: githubRepoName, name: "POSTGRES_URL", value: postgresUrl })
    } catch (error: unknown) {
      secretSyncError = errorMessage(error, "Unable to sync GitHub worker secrets")
    }
    if (secretSyncError) {
      return NextResponse.json(
        { error: `GitHub worker secret synchronization failed: ${secretSyncError}` },
        { status: 502 }
      )
    }
    const queued = pool
      ? await ensureMigrationWorkerJobs({ migrationId, mode })
      : null
    const job = pool
      ? null
      : await createRepairJob({
          migrationId,
          mode,
          requestedByAgentId: id,
          payload: { source: "github_actions", agentId: id },
        })

    let run: Awaited<ReturnType<typeof createAgentRun>>
    try {
      run = await createAgentRun({
        agentId: id,
        runType: "github_dispatch",
        status: "pending",
        jobReference: job?.id,
        summary: pool ? "Queued GitHub dispatch for the migration worker pool" : `Queued GitHub dispatch for repair job ${job?.id}`,
        payload: {
          migrationId,
          mode,
          pool,
          repoOwner: githubRepoOwner,
          repoName: githubRepoName,
          workflowFile: githubWorkflowFile,
          ref: agent.githubRef || "main",
          dispatchRequestedAt,
          githubRunIdsBeforeDispatch: Array.from(runIdsBeforeDispatch),
        },
      })
    } catch (error) {
      if (job?.id) await abortRepairJob(job.id).catch(() => undefined)
      throw error
    }

    await updateAgent(id, {
      status: "offline",
      lastError: null,
      metadata: {
        ...(agent.metadata ?? {}),
        activeRepairJobId: job?.id ?? null,
        githubDispatchRequestedAt: dispatchRequestedAt,
      },
    }).catch(() => undefined)

    const dispatchWorkflow = async (includeRuntimeInputs: boolean) =>
      fetch(
        `https://api.github.com/repos/${encodeURIComponent(githubRepoOwner)}/${encodeURIComponent(githubRepoName)}/actions/workflows/${encodeURIComponent(githubWorkflowFile)}/dispatches`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${githubToken}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ref: agent.githubRef || "main",
            inputs: includeRuntimeInputs
              ? {
                  migration_id: migrationId,
                  ...(job?.id ? { repair_job_id: job.id } : {}),
                  agent_id: id,
                  ...Object.fromEntries(
                    Object.entries(dispatchInputs).filter(
                      ([key]) => !["agent_token", "repair_job_id", "agent_id", "server_url"].includes(key)
                    )
                  ),
                }
              : {},
          }),
        }
      )

    let response: Response
    let usedRuntimeInputs = workflowSupportsRuntimeInputs
    try {
      response = await dispatchWorkflow(workflowSupportsRuntimeInputs)
      if (!response.ok && workflowSupportsRuntimeInputs) {
        const firstBody = await response.text().catch(() => "")
        if (isUnexpectedWorkflowInputsError(response.status, firstBody)) {
          usedRuntimeInputs = false
          await syncGitHubWorkerSecrets({ token: githubToken, owner: githubRepoOwner, repo: githubRepoName, serverUrl, sharedSecret, agentId: id, includeLegacyAgentId: true })
          response = await dispatchWorkflow(false)
        } else {
          response = new Response(firstBody, { status: response.status, statusText: response.statusText, headers: response.headers })
        }
      }
    } catch (error: unknown) {
      if (job?.id) await abortRepairJob(job.id).catch(() => undefined)
      return NextResponse.json({ error: errorMessage(error, "Unable to send GitHub workflow dispatch request") }, { status: 400 })
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      if (job?.id) await abortRepairJob(job.id).catch(() => undefined)
      await updateAgentRun(run.id, {
        status: "failed",
        summary: `GitHub dispatch failed: ${response.status}`,
        payload: { errorBody: text },
        completedAt: new Date().toISOString(),
      }).catch(() => undefined)
      await updateAgent(id, {
        status: "offline",
        lastError: `GitHub dispatch failed: ${response.status}`,
        metadata: {
          ...(agent.metadata ?? {}),
          activeRepairJobId: null,
        },
      }).catch(() => undefined)
      return NextResponse.json(
        {
          error: `GitHub dispatch failed (${response.status}). ${
            text || "Check token/repo/workflow access."
          }${secretSyncError ? ` Secret sync warning: ${secretSyncError}` : ""}`,
        },
        { status: 400 }
      )
    }

    if (pool) await enrollMigrationWorkerAgent(migrationId, id)
    let matchedRun: Awaited<ReturnType<typeof listGitHubWorkflowRuns>>[number] | undefined
    for (let attempt = 0; attempt < 8 && !matchedRun; attempt += 1) {
      if (attempt > 0) await sleep(1_000)
      const recentRuns = await listGitHubWorkflowRuns({
        token: githubToken,
        owner: githubRepoOwner,
        repo: githubRepoName,
        workflow: githubWorkflowFile,
        branch: agent.githubRef || "main",
        event: "workflow_dispatch",
        perPage: 20,
      }).catch(() => [])
      const newRuns = recentRuns.filter((candidate) => !runIdsBeforeDispatch.has(candidate.id))
      const runDisplayHint = pool ? id : job?.id
      matchedRun =
        (runDisplayHint ? newRuns.find((candidate) => String(candidate.displayTitle ?? "").includes(runDisplayHint)) : undefined) ??
        newRuns.find((candidate) => {
          const createdAt = Date.parse(candidate.createdAt || "")
          const requestedAt = Date.parse(dispatchRequestedAt)
          return Number.isFinite(createdAt) && Number.isFinite(requestedAt) && createdAt >= requestedAt - 10_000
        })
    }

    const updatedRun = await updateAgentRun(run.id, {
      status: matchedRun ? (matchedRun.status === "completed" ? "completed" : "running") : "pending",
      externalRunId: matchedRun?.id ?? null,
      summary: matchedRun
        ? pool
          ? `Workflow dispatched for the migration worker pool (run #${matchedRun.runNumber ?? matchedRun.id})`
          : `Workflow dispatched for repair job ${job?.id} (run #${matchedRun.runNumber ?? matchedRun.id})`
        : pool
          ? "Workflow dispatch queued for the migration worker pool; waiting for GitHub to start the run"
          : `Workflow dispatch queued for repair job ${job?.id}; waiting for GitHub to start the run`,
      payload: {
        migrationId,
        mode,
        pool,
        repoOwner: githubRepoOwner,
        repoName: githubRepoName,
        workflowFile: githubWorkflowFile,
        ref: agent.githubRef || "main",
        dispatchRequestedAt,
        githubRunIdsBeforeDispatch: Array.from(runIdsBeforeDispatch),
        usedRuntimeInputs,
        ...(secretSyncError ? { secretSyncWarning: secretSyncError } : {}),
        ...(matchedRun?.htmlUrl ? { htmlUrl: matchedRun.htmlUrl } : {}),
      },
      ...(matchedRun?.status === "completed" ? { completedAt: new Date().toISOString() } : {}),
    })

    await updateAgent(id, {
      status: matchedRun && matchedRun.status !== "completed" ? "online" : "offline",
      lastError: null,
      metadata: {
        ...(agent.metadata ?? {}),
        activeRepairJobId: matchedRun && matchedRun.status !== "completed" ? job?.id ?? null : null,
        githubAbortRequestedAt: null,
        githubDispatchRequestedAt: dispatchRequestedAt,
        ...(matchedRun?.id ? { githubRunId: matchedRun.id } : {}),
        ...(matchedRun?.status ? { githubRunStatus: matchedRun.status } : {}),
        ...(matchedRun?.conclusion ? { githubRunConclusion: matchedRun.conclusion } : {}),
        ...(matchedRun?.htmlUrl ? { githubRunUrl: matchedRun.htmlUrl } : {}),
      },
    }).catch(() => undefined)

    return NextResponse.json({ ok: true, job, jobs: queued?.jobs ?? [], run: updatedRun }, { status: 200 })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to dispatch GitHub workflow") }, { status: 400 })
  }
}
