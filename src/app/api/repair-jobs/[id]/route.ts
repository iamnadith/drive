import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { getAgentById, getAgentGithubToken, getLatestAgentRunByJobReference, updateAgent, updateAgentRun } from "@/lib/agents-store"
import {
  cancelGitHubWorkflowRun,
  forceCancelGitHubWorkflowRun,
  getGitHubWorkflowRun,
  listGitHubWorkflowRuns,
  GITHUB_TOKEN_COOKIE,
} from "@/lib/github-oauth"
import { syncMigrationLiveState } from "@/lib/migration-live-state"
import { abortRepairJob, deleteRepairJob, getRepairJob, updateRepairJob } from "@/lib/repair-jobs-store"

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

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const job = await getRepairJob(id)
    if (!job) return NextResponse.json({ error: "Repair job not found" }, { status: 404 })
    const linkedRun = await getLatestAgentRunByJobReference(id).catch(() => null)
    return NextResponse.json({ job: { ...job, linkedRun } })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to load repair job" }, { status: 400 })
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
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

    if (
      linkedRun &&
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
        return NextResponse.json({ error: "No GitHub token available to cancel the workflow run" }, { status: 400 })
      }

      const runId = await resolveGitHubRunIdForAbort({
        token: githubToken,
        owner: agent.githubRepoOwner,
        repo: agent.githubRepoName,
        workflow: agent.githubWorkflowFile || (typeof linkedRun.payload?.workflowFile === "string" ? linkedRun.payload.workflowFile : undefined),
        branch: agent.githubRef || (typeof linkedRun.payload?.ref === "string" ? linkedRun.payload.ref : undefined),
        externalRunId: linkedRun.externalRunId,
      })

      if (!runId) {
        return NextResponse.json({ error: "Could not find the GitHub workflow run to cancel" }, { status: 404 })
      }

      const cancelResult = await ensureGitHubRunCanceled({
        token: githubToken,
        owner: agent.githubRepoOwner,
        repo: agent.githubRepoName,
        runId,
      })

      if (cancelResult.status !== "canceled") {
        await updateAgentRun(linkedRun.id, {
          summary: "GitHub workflow abort requested, but GitHub has not confirmed cancellation yet",
          payload: {
            ...(linkedRun.payload ?? {}),
            githubAbortRequestedAt: new Date().toISOString(),
            githubStatus: cancelResult.githubStatus ?? null,
            githubConclusion: cancelResult.githubConclusion ?? null,
            githubUpdatedAt: cancelResult.updatedAt ?? null,
            ...(cancelResult.htmlUrl ? { htmlUrl: cancelResult.htmlUrl } : {}),
          },
        }).catch(() => undefined)

        return NextResponse.json(
          {
            error:
              cancelResult.status === "running"
                ? "GitHub accepted the abort request, but the workflow run is still running. Try again in a few seconds."
                : cancelResult.status === "failed"
                  ? "GitHub workflow ended as failed instead of canceled."
                  : "GitHub workflow completed before it could be canceled.",
          },
          { status: 409 }
        )
      }

      await updateAgentRun(linkedRun.id, {
        status: "canceled",
        completedAt: new Date().toISOString(),
        summary: "GitHub workflow abort requested by user",
        payload: {
          ...(linkedRun.payload ?? {}),
          githubRunId: runId,
          githubAbortRequestedAt: new Date().toISOString(),
          githubStatus: cancelResult.githubStatus ?? null,
          githubConclusion: cancelResult.githubConclusion ?? null,
          githubUpdatedAt: cancelResult.updatedAt ?? null,
          ...(cancelResult.htmlUrl ? { htmlUrl: cancelResult.htmlUrl } : {}),
        },
      }).catch(() => undefined)

      await updateAgent(agent.id, {
        status: "offline",
        lastError: null,
        metadata: {
          ...(agent.metadata ?? {}),
          activeRepairJobId: null,
          lastRepairJobAbortAt: new Date().toISOString(),
          githubAbortRequestedAt: new Date().toISOString(),
          githubRunStatus: cancelResult.githubStatus ?? null,
          githubRunConclusion: cancelResult.githubConclusion ?? null,
          githubRunUpdatedAt: cancelResult.updatedAt ?? null,
          ...(cancelResult.htmlUrl ? { githubRunUrl: cancelResult.htmlUrl } : {}),
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

      const updatedJob = await abortRepairJob(id)
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
        status: "offline",
        lastError: null,
        metadata: {
          ...(agent.metadata ?? {}),
          activeRepairJobId: null,
          lastRepairJobAbortAt: new Date().toISOString(),
        },
      }).catch(() => undefined)
    }

    const updatedJob = await abortRepairJob(id)
    await syncMigrationLiveState(updatedJob.migrationId).catch(() => undefined)
    const refreshedRun = await getLatestAgentRunByJobReference(id).catch(() => null)
    return NextResponse.json({ ok: true, job: { ...updatedJob, linkedRun: refreshedRun } })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to update repair job" }, { status: 400 })
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const job = await getRepairJob(id)
    if (!job) return NextResponse.json({ error: "Repair job not found" }, { status: 404 })

    await deleteRepairJob(id)
    return NextResponse.json({ ok: true })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to delete repair job" }, { status: 400 })
  }
}
