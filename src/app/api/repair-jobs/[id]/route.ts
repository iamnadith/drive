import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getAgentById, getAgentGithubToken, getLatestAgentRunByJobReference, listAgentRunsByAgentId, listAgents, updateAgent, updateAgentRun } from "@/lib/agents-store"
import {
  cancelGitHubWorkflowRun,
  forceCancelGitHubWorkflowRun,
  getGitHubWorkflowRun,
  listGitHubWorkflowRuns,
  GITHUB_TOKEN_COOKIE,
} from "@/lib/github-oauth"
import { syncMigrationLiveState } from "@/lib/migration-live-state"
import { abortRepairJob, deleteRepairJob, getRepairJob } from "@/lib/repair-jobs-store"
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
    if (status === "canceled") {
      return {
        terminal: true,
        status,
        githubStatus: currentStatus,
        githubConclusion: conclusion,
        htmlUrl: run.htmlUrl,
        updatedAt: run.updatedAt,
      }
    }
    if (status === "completed" || status === "failed") {
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

async function resolveGitHubRunIdForAbort(input: {
  token: string
  owner: string
  repo: string
  workflow?: string
  branch?: string
  externalRunId?: string
}): Promise<string | null> {
  if (input.externalRunId) return input.externalRunId
  if (!input.workflow) return null

  const runs = await listGitHubWorkflowRuns({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    workflow: input.workflow,
    branch: input.branch,
    event: "workflow_dispatch",
    perPage: 20,
  }).catch(() => [])

  const active = runs.find((run) => {
    const status = String(run.status ?? "").toLowerCase()
    return status === "queued" || status === "in_progress" || status === "waiting" || status === "requested" || status === "pending"
  })

  return active?.id ?? runs[0]?.id ?? null
}

async function resolveGitHubRunIdsForAbort(input: {
  agentId: string
  jobId: string
  owner: string
  repo: string
  token: string
  workflow?: string
  branch?: string
  linkedRun?: Awaited<ReturnType<typeof getLatestAgentRunByJobReference>> | null
}): Promise<string[]> {
  const allWorkers = await listAgents().catch(() => [])
  const workerWithRun = allWorkers.find((entry) => entry.id === input.agentId) ?? null
  const agentRuns = await listAgentRunsByAgentId(input.agentId, 50).catch(() => [])

  const relevantRuns = agentRuns.filter((run) => {
    if (run.runType !== "github_dispatch") return false
    if (run.jobReference === input.jobId) return true
    return run.status === "pending" || run.status === "running"
  })

  const runIds = new Set<string>()
  if (input.linkedRun?.externalRunId) runIds.add(input.linkedRun.externalRunId)
  if (workerWithRun?.latestRun?.externalRunId) runIds.add(workerWithRun.latestRun.externalRunId)
  for (const run of relevantRuns) {
    if (run.externalRunId) runIds.add(run.externalRunId)
  }

  if (runIds.size === 0) {
    const fallbackRunId = await resolveGitHubRunIdForAbort({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      workflow: input.workflow,
      branch: input.branch,
      externalRunId: input.linkedRun?.externalRunId,
    })
    if (fallbackRunId) runIds.add(fallbackRunId)
  }

  return Array.from(runIds)
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const job = await getRepairJob(id)
    if (!job) return NextResponse.json({ error: "Repair job not found" }, { status: 404 })
    const linkedRun = await getLatestAgentRunByJobReference(id).catch(() => null)
    return NextResponse.json({ job: { ...job, linkedRun } })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to load repair job") }, { status: 400 })
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = typeof body.action === "string" ? body.action : ""
    if (action !== "abort" && action !== "stop_github_run") {
      return NextResponse.json({ error: "Unsupported repair job action" }, { status: 400 })
    }

    const job = await getRepairJob(id)
    if (!job) return NextResponse.json({ error: "Repair job not found" }, { status: 404 })

    const linkedRun = await getLatestAgentRunByJobReference(id).catch(() => null)
    const agentId = job.claimedByAgentId || job.requestedByAgentId
    const agent = agentId ? await getAgentById(agentId).catch(() => null) : null
    const locallyAbortedJob = await abortRepairJob(id)
    if (locallyAbortedJob) {
      await syncMigrationLiveState(locallyAbortedJob.migrationId).catch(() => undefined)
    }

    if (
      agent &&
      agent.provider === "github_actions" &&
      agent.githubRepoOwner &&
      agent.githubRepoName
    ) {
      const githubToken =
        (await getAgentGithubToken(agent.id).catch(() => null)) ||
        (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value ||
        getGitHubTokenFallback()

      if (!githubToken) {
        if (locallyAbortedJob) {
          return NextResponse.json({
            ok: true,
            abortRequested: true,
            remoteCancellationPending: true,
            warning: "Worker job was aborted, but no GitHub token was available to stop the workflow run.",
            job: locallyAbortedJob,
          })
        }
        return NextResponse.json({ error: "No GitHub token available to cancel the workflow run" }, { status: 400 })
      }

      const runIds = await resolveGitHubRunIdsForAbort({
        agentId: agent.id,
        jobId: id,
        token: githubToken,
        owner: agent.githubRepoOwner,
        repo: agent.githubRepoName,
        workflow: agent.githubWorkflowFile || (typeof linkedRun?.payload?.workflowFile === "string" ? linkedRun.payload.workflowFile : undefined),
        branch: agent.githubRef || (typeof linkedRun?.payload?.ref === "string" ? linkedRun.payload.ref : undefined),
        linkedRun,
      })

      if (runIds.length === 0) {
        if (locallyAbortedJob) {
          return NextResponse.json({
            ok: true,
            abortRequested: true,
            remoteCancellationPending: true,
            warning: "Worker job was aborted, but the GitHub workflow run could not be located.",
            job: locallyAbortedJob,
          })
        }
        return NextResponse.json({ error: "Could not find the GitHub workflow run to cancel" }, { status: 404 })
      }

      const cancelResults = []
      for (const runId of runIds) {
        cancelResults.push(
          await ensureGitHubRunCanceled({
            token: githubToken,
            owner: agent.githubRepoOwner,
            repo: agent.githubRepoName,
            runId,
          })
        )
      }

      const uncanceled = cancelResults.find((result) => result.status !== "canceled")
      if (uncanceled) {
        if (linkedRun) {
          await updateAgentRun(linkedRun.id, {
            summary: "GitHub workflow abort requested, but GitHub has not confirmed cancellation yet",
            payload: {
              ...(linkedRun.payload ?? {}),
              githubAbortRequestedAt: new Date().toISOString(),
              githubStatus: uncanceled.githubStatus ?? null,
              githubConclusion: uncanceled.githubConclusion ?? null,
              githubUpdatedAt: uncanceled.updatedAt ?? null,
              ...(uncanceled.htmlUrl ? { htmlUrl: uncanceled.htmlUrl } : {}),
            },
          }).catch(() => undefined)
        }

        if (locallyAbortedJob) {
          return NextResponse.json({
            ok: true,
            abortRequested: true,
            remoteCancellationPending: uncanceled.status === "running",
            warning:
              uncanceled.status === "running"
                ? "Worker job was aborted; GitHub cancellation is still pending."
                : `Worker job was aborted; GitHub workflow ended as ${uncanceled.status}.`,
            job: locallyAbortedJob,
          })
        }
        return NextResponse.json({ error: "GitHub workflow cancellation was not confirmed." }, { status: 409 })
      }

      const now = new Date().toISOString()
      if (linkedRun) {
        const lastCancelResult = cancelResults[cancelResults.length - 1]
        await updateAgentRun(linkedRun.id, {
          status: "canceled",
          completedAt: now,
          summary: "GitHub workflow abort requested by user",
          payload: {
            ...(linkedRun.payload ?? {}),
            githubRunId: runIds[0] ?? null,
            githubAbortRequestedAt: now,
            githubStatus: lastCancelResult?.githubStatus ?? null,
            githubConclusion: lastCancelResult?.githubConclusion ?? null,
            githubUpdatedAt: lastCancelResult?.updatedAt ?? null,
            ...(lastCancelResult?.htmlUrl ? { htmlUrl: lastCancelResult.htmlUrl } : {}),
          },
        }).catch(() => undefined)
      }

      const agentRuns = await listAgentRunsByAgentId(agent.id, 50).catch(() => [])
      for (const run of agentRuns) {
        if (run.runType !== "github_dispatch") continue
        if (run.jobReference !== id && run.status !== "pending" && run.status !== "running") continue
        await updateAgentRun(run.id, {
          status: "canceled",
          completedAt: now,
          summary: "GitHub worker aborted by user",
          payload: {
            ...(run.payload ?? {}),
            githubAbortRequestedAt: now,
          },
        }).catch(() => undefined)
      }

      await updateAgent(agent.id, {
        status: "offline",
        lastError: null,
        metadata: {
          ...(agent.metadata ?? {}),
          activeRepairJobId: null,
          lastRepairJobAbortAt: now,
          githubAbortRequestedAt: now,
        },
      }).catch(() => undefined)

      if (action === "stop_github_run") {
        const currentJob = await getRepairJob(id).catch(() => null)
        await syncMigrationLiveState(job.migrationId).catch(() => undefined)
        const refreshedRun = await getLatestAgentRunByJobReference(id).catch(() => null)
        return NextResponse.json({
          ok: true,
          githubRunStopped: true,
          job: currentJob ? { ...currentJob, linkedRun: refreshedRun } : null,
        })
      }

      const updatedJob = locallyAbortedJob ?? (await abortRepairJob(id))
      await syncMigrationLiveState(updatedJob.migrationId).catch(() => undefined)
      const refreshedRun = await getLatestAgentRunByJobReference(id).catch(() => null)
      return NextResponse.json({
        ok: true,
        abortRequested: true,
        job: { ...updatedJob, linkedRun: refreshedRun },
      })
    }

    if (agent) {
      await updateAgent(agent.id, {
        status: agent.provider === "self_hosted" || agent.provider === "local" ? "online" : "offline",
        lastError: null,
        metadata: {
          ...(agent.metadata ?? {}),
          activeRepairJobId: null,
          lastRepairJobAbortAt: new Date().toISOString(),
        },
      }).catch(() => undefined)
    }

    const updatedJob = locallyAbortedJob ?? (await abortRepairJob(id))
    await syncMigrationLiveState(updatedJob.migrationId).catch(() => undefined)
    const refreshedRun = await getLatestAgentRunByJobReference(id).catch(() => null)
    return NextResponse.json({ ok: true, job: { ...updatedJob, linkedRun: refreshedRun } })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to update repair job") }, { status: 400 })
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const job = await getRepairJob(id)
    if (!job) return NextResponse.json({ error: "Repair job not found" }, { status: 404 })

    if (job.status === "pending" || job.status === "claimed" || job.status === "running") {
      await abortRepairJob(id)
    }
    await deleteRepairJob(id)
    await syncMigrationLiveState(job.migrationId).catch(() => undefined)
    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to delete repair job") }, { status: 400 })
  }
}
