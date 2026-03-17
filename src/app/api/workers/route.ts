import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { POST as createWorker } from "@/app/api/agents/route"
import { getAgentGithubToken, listAgents, updateAgentRun } from "@/lib/agents-store"
import { GITHUB_TOKEN_COOKIE, getGitHubWorkflowRun, listGitHubWorkflowRuns } from "@/lib/github-oauth"
import { getRepairJob, updateRepairJob } from "@/lib/repair-jobs-store"

function getGitHubTokenFallback(): string {
  return (
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  ).trim()
}

function isRecentIso(value: string | undefined, maxAgeMs: number): boolean {
  if (!value) return false
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return false
  return Date.now() - time <= maxAgeMs
}

export async function GET() {
  try {
    const agents = await listAgents()
    const cookieToken = (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value ?? ""

    for (const agent of agents) {
      if (agent.provider !== "github_actions" || !agent.latestRun || agent.latestRun.runType !== "github_dispatch") continue
      if (!agent.githubRepoOwner || !agent.githubRepoName || !agent.githubWorkflowFile) continue

      const githubToken = (await getAgentGithubToken(agent.id)) || cookieToken || getGitHubTokenFallback()
      if (!githubToken) continue

      const latestRun = agent.latestRun
      let githubRun: Awaited<ReturnType<typeof getGitHubWorkflowRun>> | null = null

      if (latestRun.externalRunId) {
        githubRun = await getGitHubWorkflowRun({
          token: githubToken,
          owner: agent.githubRepoOwner,
          repo: agent.githubRepoName,
          runId: latestRun.externalRunId,
        }).catch(() => null)
      } else {
        const runs = await listGitHubWorkflowRuns({
          token: githubToken,
          owner: agent.githubRepoOwner,
          repo: agent.githubRepoName,
          workflow: agent.githubWorkflowFile,
          branch: agent.githubRef || "main",
          event: "workflow_dispatch",
          perPage: 10,
        }).catch(() => [])
        if (latestRun.jobReference) {
          const activeRepairJob = await getRepairJob(latestRun.jobReference).catch(() => null)
          const isActiveRepairJob =
            activeRepairJob &&
            (activeRepairJob.status === "pending" ||
              activeRepairJob.status === "claimed" ||
              activeRepairJob.status === "running")
          if (isActiveRepairJob) {
            githubRun = null
          } else {
            githubRun = runs[0] ?? null
          }
        } else {
          githubRun = runs[0] ?? null
        }
      }

      if (!githubRun) continue

      const currentStatus = String(githubRun.status ?? "").toLowerCase()
      const conclusion = String(githubRun.conclusion ?? "").toLowerCase()
      const runStatus =
        currentStatus === "completed"
          ? conclusion === "success"
            ? "completed"
            : conclusion === "cancelled"
              ? "canceled"
              : "failed"
          : "running"

      await updateAgentRun(latestRun.id, {
        status: runStatus,
        externalRunId: githubRun.id,
        summary:
          runStatus === "completed"
            ? "GitHub workflow completed successfully"
            : runStatus === "canceled"
              ? "GitHub workflow was canceled"
              : runStatus === "failed"
                ? `GitHub workflow failed${conclusion ? ` (${conclusion})` : ""}`
                : "GitHub workflow is running",
        payload: {
          ...(latestRun.payload ?? {}),
          ...(githubRun.htmlUrl ? { htmlUrl: githubRun.htmlUrl } : {}),
          githubStatus: currentStatus || null,
          githubConclusion: conclusion || null,
          githubUpdatedAt: githubRun.updatedAt ?? null,
        },
        ...(runStatus === "completed" || runStatus === "failed" || runStatus === "canceled"
          ? { completedAt: new Date().toISOString() }
          : {}),
      }).catch(() => undefined)

      if ((runStatus === "failed" || runStatus === "canceled") && latestRun.jobReference) {
        const repairJob = await getRepairJob(latestRun.jobReference).catch(() => null)
        if (repairJob && (repairJob.status === "pending" || repairJob.status === "claimed" || repairJob.status === "running")) {
          const repairJobHeartbeatIsRecent = isRecentIso(repairJob.lastHeartbeatAt, 90_000)
          const repairJobStartedAfterRun = Boolean(
            repairJob.startedAt &&
              latestRun.createdAt &&
              new Date(repairJob.startedAt).getTime() >= new Date(latestRun.createdAt).getTime()
          )
          if (!repairJobHeartbeatIsRecent || !repairJobStartedAfterRun || repairJob.status === "pending" || repairJob.status === "claimed") {
            await updateRepairJob(repairJob.id, {
              status: runStatus === "canceled" ? "canceled" : "failed",
              summary: runStatus === "canceled" ? "GitHub workflow was canceled before worker completed the job" : "GitHub workflow failed before worker completed the job",
              error: runStatus === "failed" ? `GitHub workflow failed${conclusion ? ` (${conclusion})` : ""}` : "GitHub workflow was canceled",
              completedAt: new Date().toISOString(),
            }).catch(() => undefined)
          }
        }
      }
    }

    const freshAgents = await listAgents()
    return NextResponse.json({ agents: freshAgents })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to load workers" }, { status: 400 })
  }
}

export const POST = createWorker
