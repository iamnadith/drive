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
import { syncMigrationLiveState } from "@/lib/migration-live-state"
import { requireAdmin } from "@/lib/server-auth"

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
      event: "workflow_dispatch",
      perPage: 20,
    }).catch(() => [])

    for (const run of runs) {
      const status = String(run.status ?? "").toLowerCase()
      if (status === "queued" || status === "in_progress" || status === "waiting" || status === "requested" || status === "pending") {
        runIds.add(run.id)
      }
    }

    if (runIds.size === 0 && runs[0]?.id) runIds.add(runs[0].id)
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
  const linkedJobs = (await listRepairJobs(200)).filter(
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
      githubAbortRequestedAt: now,
    },
    lastHeartbeatAt: now,
  }).catch(() => undefined)

  const migrationIds = Array.from(new Set(linkedJobs.map((job) => job.migrationId).filter(Boolean)))
  for (const migrationId of migrationIds) {
    await syncMigrationLiveState(migrationId).catch(() => undefined)
  }

  return {
    workerId,
    abortedJobIds: activeLinkedJobs.map((job) => job.id),
    stoppedRunIds: runIds,
    linkedJobs,
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = typeof body.action === "string" ? body.action : ""
    if (action !== "stop") {
      return NextResponse.json({ error: "Unsupported worker action" }, { status: 400 })
    }

    const result = await stopGithubWorkerById(id)
    return NextResponse.json({ ok: true, ...result })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to stop worker")
    const status = typeof message === "string" && message.includes("still running") ? 409 : 400
    return NextResponse.json({ error: message }, { status })
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const worker = await getAgentById(id)
    if (!worker) return NextResponse.json({ error: "Worker not found" }, { status: 404 })

    await deleteAgent(id)
    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to delete worker") }, { status: 400 })
  }
}
