import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { deleteAgent, getAgentById, getAgentGithubToken, listAgentRunsByAgentId, listAgents, updateAgent, updateAgentRun } from "@/lib/agents-store"
import { abortRepairJob, listRepairJobs } from "@/lib/repair-jobs-store"
import {
  cancelGitHubWorkflowRun,
  forceCancelGitHubWorkflowRun,
  getGitHubWorkflowRun,
  listGitHubWorkflowRuns,
  GITHUB_TOKEN_COOKIE,
} from "@/lib/github-oauth"
import { requireAdmin } from "@/lib/server-auth"
import { recordUserActivity } from "@/lib/activity-audit"

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function getGitHubTokenFallback(): string {
  return (
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  ).trim()
}

function isActiveRunStatus(status: string | undefined): boolean {
  return status === "pending" || status === "running"
}

function isActiveJobStatus(status: string | undefined): boolean {
  return status === "pending" || status === "claimed" || status === "running"
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeGitHubRunTerminalStatus(status: string, conclusion: string): "completed" | "failed" | "canceled" | "running" {
  if (status !== "completed") return "running"
  if (conclusion === "success") return "completed"
  if (conclusion === "cancelled" || conclusion === "cancelled_by_user") return "canceled"
  return "failed"
}

async function ensureGitHubRunCanceled(input: {
  token: string
  owner: string
  repo: string
  runId: string
}): Promise<{
  terminal: boolean
  status: "completed" | "failed" | "canceled" | "running"
  githubStatus?: string
  githubConclusion?: string
  htmlUrl?: string
  updatedAt?: string
}> {
  await cancelGitHubWorkflowRun(input)
  await forceCancelGitHubWorkflowRun(input).catch(() => undefined)

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(attempt === 0 ? 1200 : 2500)
    const run = await getGitHubWorkflowRun(input)
    const currentStatus = String(run.status ?? "").toLowerCase()
    const conclusion = String(run.conclusion ?? "").toLowerCase()
    const status = normalizeGitHubRunTerminalStatus(currentStatus, conclusion)
    if (status === "canceled" || status === "completed" || status === "failed") {
      return {
        terminal: true,
        status,
        githubStatus: currentStatus,
        githubConclusion: conclusion,
        htmlUrl: run.htmlUrl,
        updatedAt: run.updatedAt,
      }
    }
    if (attempt < 8 && (attempt === 1 || attempt === 3 || attempt === 5 || attempt === 7)) {
      await cancelGitHubWorkflowRun(input).catch(() => undefined)
      await forceCancelGitHubWorkflowRun(input).catch(() => undefined)
    }
  }

  const finalRun = await getGitHubWorkflowRun(input)
  const currentStatus = String(finalRun.status ?? "").toLowerCase()
  const conclusion = String(finalRun.conclusion ?? "").toLowerCase()
  return {
    terminal: currentStatus === "completed",
    status: normalizeGitHubRunTerminalStatus(currentStatus, conclusion),
    githubStatus: currentStatus,
    githubConclusion: conclusion,
    htmlUrl: finalRun.htmlUrl,
    updatedAt: finalRun.updatedAt,
  }
}

async function resolveGitHubRunIdsForWorkerStop(input: {
  workerId: string
  owner: string
  repo: string
  token: string
  workflow?: string
  branch?: string
  latestRunExternalId?: string | null
  latestRunStatus?: string | null
  relevantRuns: Array<{ externalRunId?: string | null }>
}): Promise<string[]> {
  const runIds = new Set<string>()
  if (input.latestRunExternalId && isActiveRunStatus(input.latestRunStatus ?? undefined)) {
    runIds.add(input.latestRunExternalId)
  }
  for (const run of input.relevantRuns) {
    if (run.externalRunId) runIds.add(run.externalRunId)
  }

  if (input.workflow) {
    const runs = await listGitHubWorkflowRuns({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      workflow: input.workflow,
      branch: input.branch,
      event: "repository_dispatch",
      perPage: 20,
    }).catch(() => [])

    for (const run of runs) {
      const status = String(run.status ?? "").toLowerCase()
      if (status === "queued" || status === "in_progress" || status === "waiting" || status === "requested" || status === "pending") {
        // Multiple worker records may intentionally share one repository.
        // The bundled workflow embeds the agent id in run-name, so only use
        // runs that belong to this worker when the external id was not indexed
        // yet. Never cancel an unrelated worker's run from the same repo.
        const identity = `${run.displayTitle ?? ""} ${run.name ?? ""}`
        if (identity.includes(input.workerId)) runIds.add(run.id)
      }
    }
  }

  return Array.from(runIds)
}

async function stopGithubWorkerById(workerId: string) {
  const worker = await getAgentById(workerId)
  if (!worker) throw new Error("Worker not found")
  if (worker.provider !== "github_actions") throw new Error("Only GitHub Actions workers can be stopped")
  if (!worker.githubRepoOwner || !worker.githubRepoName) throw new Error("GitHub worker is missing repo configuration")

  const allWorkers = await listAgents()
  const workerWithRun = allWorkers.find((entry) => entry.id === workerId) ?? { ...worker, latestRun: null }
  const linkedJobs = (await listRepairJobs(500)).filter(
    (job) => job.claimedByAgentId === workerId || job.requestedByAgentId === workerId
  )
  const activeLinkedJobs = linkedJobs.filter((job) => isActiveJobStatus(job.status))
  const agentRuns = await listAgentRunsByAgentId(workerId, 50)
  const linkedJobIds = new Set(linkedJobs.map((job) => job.id))
  const relevantRuns = agentRuns.filter(
    (run) =>
      run.runType === "github_dispatch" &&
      (isActiveRunStatus(run.status) || (run.jobReference ? linkedJobIds.has(run.jobReference) : false))
  )

  const githubToken =
    (await getAgentGithubToken(workerId).catch(() => null)) ||
    (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value ||
    getGitHubTokenFallback()
  if (!githubToken) throw new Error("No GitHub token available to stop the worker")

  const runIds = await resolveGitHubRunIdsForWorkerStop({
    workerId,
    token: githubToken,
    owner: worker.githubRepoOwner,
    repo: worker.githubRepoName,
    workflow: worker.githubWorkflowFile || undefined,
    branch: worker.githubRef || undefined,
    latestRunExternalId: workerWithRun.latestRun?.externalRunId ?? null,
    latestRunStatus: workerWithRun.latestRun?.status ?? null,
    relevantRuns,
  })

  if (runIds.length === 0) {
    throw new Error("Could not find the GitHub workflow run to cancel")
  }

  for (const job of activeLinkedJobs) {
    await abortRepairJob(job.id).catch(() => undefined)
  }

  const cancelResults = []
  for (const runId of runIds) {
    cancelResults.push(await ensureGitHubRunCanceled({
      token: githubToken,
      owner: worker.githubRepoOwner,
      repo: worker.githubRepoName,
      runId,
    }))
  }

  const uncanceled = cancelResults.find((result) => result.status !== "canceled")
  if (uncanceled) {
    throw new Error(
      uncanceled.status === "running"
        ? "GitHub accepted the stop request, but the workflow run is still running. Try again in a few seconds."
        : uncanceled.status === "failed"
          ? "GitHub workflow ended as failed instead of canceled."
          : "GitHub workflow completed before it could be canceled."
    )
  }

  const now = new Date().toISOString()
  for (const run of relevantRuns) {
    if (run.runType !== "github_dispatch") continue
    if (run.status !== "pending" && run.status !== "running") continue
    const lastCancelResult = cancelResults[cancelResults.length - 1]
    await updateAgentRun(run.id, {
      status: "canceled",
      completedAt: now,
      summary: "GitHub worker stopped by user",
      payload: {
        ...(run.payload ?? {}),
        githubAbortRequestedAt: now,
        githubStatus: lastCancelResult?.githubStatus ?? null,
        githubConclusion: lastCancelResult?.githubConclusion ?? null,
        githubUpdatedAt: lastCancelResult?.updatedAt ?? null,
        ...(lastCancelResult?.htmlUrl ? { htmlUrl: lastCancelResult.htmlUrl } : {}),
      },
    }).catch(() => undefined)
  }

  await updateAgent(workerId, {
    status: "offline",
    lastError: null,
    metadata: {
      ...(worker.metadata ?? {}),
      activeRepairJobId: null,
      activeMigrationId: null,
      githubAbortRequestedAt: now,
    },
    lastHeartbeatAt: now,
  }).catch(() => undefined)

  return {
    workerId,
    abortedJobIds: activeLinkedJobs.map((job) => job.id),
    stoppedRunIds: runIds,
    linkedJobs,
  }
}

async function stopGithubWorkerRun(workerId: string, agentRunId: string) {
  const worker = await getAgentById(workerId)
  if (!worker || worker.provider !== "github_actions" || !worker.githubRepoOwner || !worker.githubRepoName) {
    throw new Error("Registered GitHub workflow not found")
  }
  const runs = await listAgentRunsByAgentId(workerId, 50)
  const run = runs.find((candidate) => candidate.id === agentRunId && candidate.runType === "github_dispatch")
  if (!run) throw new Error("Workflow worker run not found")
  if (!isActiveRunStatus(run.status)) throw new Error("Workflow worker run is no longer active")
  if (!run.externalRunId) throw new Error("GitHub has not exposed this worker run id yet; refresh and retry")
  const githubToken =
    (await getAgentGithubToken(workerId).catch(() => null)) ||
    (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value ||
    getGitHubTokenFallback()
  if (!githubToken) throw new Error("No GitHub token available to stop this workflow worker")

  const linkedJobs = await listRepairJobs(500)
  const workerInstanceId = typeof run.payload?.workerInstanceId === "string" ? run.payload.workerInstanceId : ""
  const ownedJobs = linkedJobs.filter((candidate) =>
    isActiveJobStatus(candidate.status) &&
    (candidate.id === run.jobReference || (workerInstanceId && candidate.payload?.claimedWorkerInstanceId === workerInstanceId))
  )
  for (const job of ownedJobs) await abortRepairJob(job.id)
  const stopped = await ensureGitHubRunCanceled({
    token: githubToken,
    owner: worker.githubRepoOwner,
    repo: worker.githubRepoName,
    runId: run.externalRunId,
  })
  if (stopped.status !== "canceled") throw new Error("GitHub worker run did not reach canceled state")
  const now = new Date().toISOString()
  await updateAgentRun(run.id, {
    status: "canceled",
    completedAt: now,
    summary: "Individual workflow worker stopped by user",
    payload: { ...(run.payload ?? {}), githubAbortRequestedAt: now },
  })
  const remaining = runs.filter((candidate) => candidate.id !== run.id && isActiveRunStatus(candidate.status))
  await updateAgent(workerId, {
    status: remaining.length > 0 ? "online" : "offline",
    lastError: null,
    metadata: { ...(worker.metadata ?? {}), activeWorkflowRuns: remaining.length },
  }).catch(() => undefined)
  return { workerId, runId: run.id, githubRunId: run.externalRunId }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    return NextResponse.json({ error: "GitHub workflow cancellation is owned by the Migration Orchestrator. Abort the worker-pool attempt from its migration details." }, { status: 409 })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to stop worker")
    const status = typeof message === "string" && message.includes("still running") ? 409 : 400
    return NextResponse.json({ error: message }, { status })
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response
    const { id } = await context.params
    const worker = await getAgentById(id)
    if (!worker) return NextResponse.json({ error: "Registered workflow not found" }, { status: 404 })
    if (worker.provider !== "github_actions") return NextResponse.json({ error: "Worker count only applies to GitHub workflows" }, { status: 409 })
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const workerCount = Number(body.workerCount)
    if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 5) {
      return NextResponse.json({ error: "Worker count must be an integer from 1 to 5" }, { status: 400 })
    }
    const updated = await updateAgent(id, { workerCount })
    await recordUserActivity(request, auth.user.id, {
      action: "worker.configuration.updated", entityType: "worker", entityId: id,
      entityLabel: worker.name, summary: `Updated worker count for ${worker.name}`,
      before: { workerCount: worker.workerCount }, after: { workerCount: updated.workerCount },
    })
    return NextResponse.json({ ok: true, agent: updated })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to update workflow worker count") }, { status: 400 })
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const worker = await getAgentById(id)
    if (!worker) return NextResponse.json({ error: "Worker not found" }, { status: 404 })

    const linkedJobs = await listRepairJobs(500)
    if (linkedJobs.some((job) =>
      (job.claimedByAgentId === id || job.requestedByAgentId === id) &&
      (job.status === "pending" || job.status === "claimed" || job.status === "running")
    )) {
      return NextResponse.json({ error: "This worker has active migration jobs. Abort the worker-pool attempt through the Migration Orchestrator and wait for shutdown before deleting the workflow." }, { status: 409 })
    }

    if (worker.provider === "github_actions") {
      const activeRuns = await listAgentRunsByAgentId(id, 100)
      if (activeRuns.some((run) => run.runType === "github_dispatch" && (run.status === "pending" || run.status === "running"))) {
        return NextResponse.json({ error: "This workflow has an active GitHub run. Abort its worker-pool attempt through the Migration Orchestrator before deleting the workflow." }, { status: 409 })
      }
    }

    await deleteAgent(id)
    await recordUserActivity(_request, auth.user.id, {
      action: "worker.deleted", entityType: "worker", entityId: id, entityLabel: worker.name,
      summary: `Deleted worker ${worker.name}`, before: { provider: worker.provider, status: worker.status },
    })
    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to delete worker") }, { status: 400 })
  }
}
