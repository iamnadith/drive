import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createAgentRun, ensureAgentRegistrationToken, getAgentById, getAgentGithubToken, updateAgentRun } from "@/lib/agents-store"
import { createRepairJob, type RepairJobMode } from "@/lib/repair-jobs-store"
import { GITHUB_TOKEN_COOKIE, listGitHubWorkflowRuns, setGitHubActionsSecret } from "@/lib/github-oauth"

function getGitHubTokenFallback(): string {
  return (
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  ).trim()
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const agent = await getAgentById(id)
    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 })
    if (agent.provider !== "github_actions") {
      return NextResponse.json({ error: "This agent is not configured for GitHub Actions" }, { status: 400 })
    }
    if (!agent.githubRepoOwner || !agent.githubRepoName || !agent.githubWorkflowFile) {
      return NextResponse.json({ error: "GitHub repo owner, repo name, and workflow file are required" }, { status: 400 })
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const migrationId = typeof body.migrationId === "string" ? body.migrationId.trim() : ""
    const mode = (
      typeof body.mode === "string" && ["verify_only", "repair_only", "repair_and_verify"].includes(body.mode)
        ? body.mode
        : "repair_and_verify"
    ) as RepairJobMode
    const dispatchInputs =
      typeof body.inputs === "object" && body.inputs !== null ? (body.inputs as Record<string, unknown>) : {}

    if (!migrationId) return NextResponse.json({ error: "migrationId is required" }, { status: 400 })

    const githubToken = (await getAgentGithubToken(id)) || (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value || getGitHubTokenFallback()
    if (!githubToken) {
      return NextResponse.json(
        { error: "No GitHub token available. Save one on the agent or set GITHUB_TOKEN on the server." },
        { status: 400 }
      )
    }

    const registrationToken = await ensureAgentRegistrationToken(id)

    const serverUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || new URL(request.url).origin).replace(/\/+$/, "")
    await setGitHubActionsSecret({
      token: githubToken,
      owner: agent.githubRepoOwner,
      repo: agent.githubRepoName,
      name: "DRIVE_SERVER_URL",
      value: serverUrl,
    })
    await setGitHubActionsSecret({
      token: githubToken,
      owner: agent.githubRepoOwner,
      repo: agent.githubRepoName,
      name: "DRIVE_AGENT_ID",
      value: agent.id,
    })
    await setGitHubActionsSecret({
      token: githubToken,
      owner: agent.githubRepoOwner,
      repo: agent.githubRepoName,
      name: "DRIVE_AGENT_TOKEN",
      value: registrationToken,
    })

    const job = await createRepairJob({
      migrationId,
      mode,
      requestedByAgentId: id,
      payload: {
        source: "github_actions",
        agentId: id,
      },
    })

    const run = await createAgentRun({
      agentId: id,
      runType: "github_dispatch",
      status: "running",
      jobReference: job.id,
      summary: `Dispatching workflow for repair job ${job.id}`,
      payload: {
        migrationId,
        mode,
        repoOwner: agent.githubRepoOwner,
        repoName: agent.githubRepoName,
        workflowFile: agent.githubWorkflowFile,
        ref: agent.githubRef || "main",
      },
    })

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(agent.githubRepoOwner)}/${encodeURIComponent(agent.githubRepoName)}/actions/workflows/${encodeURIComponent(agent.githubWorkflowFile)}/dispatches`,
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
          inputs: {
            migration_id: migrationId,
            repair_job_id: job.id,
            agent_id: id,
            ...dispatchInputs,
          },
        }),
      }
    )

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      await updateAgentRun(run.id, {
        status: "failed",
        summary: `GitHub dispatch failed: ${response.status}`,
        payload: { errorBody: text },
        completedAt: new Date().toISOString(),
      }).catch(() => undefined)
      return NextResponse.json(
        { error: `GitHub dispatch failed (${response.status}). ${text || "Check token/repo/workflow access."}` },
        { status: 400 }
      )
    }

    const recentRuns = await listGitHubWorkflowRuns({
      token: githubToken,
      owner: agent.githubRepoOwner,
      repo: agent.githubRepoName,
      workflow: agent.githubWorkflowFile,
      branch: agent.githubRef || "main",
      event: "workflow_dispatch",
      perPage: 10,
    }).catch(() => [])

    const matchedRun = recentRuns[0]

    const updatedRun = await updateAgentRun(run.id, {
      status: matchedRun?.status === "completed" ? "completed" : "running",
      externalRunId: matchedRun?.id ?? null,
      summary: matchedRun
        ? `Workflow dispatched for repair job ${job.id} (run #${matchedRun.runNumber ?? matchedRun.id})`
        : `Workflow dispatched for repair job ${job.id}`,
      payload: {
        migrationId,
        mode,
        repoOwner: agent.githubRepoOwner,
        repoName: agent.githubRepoName,
        workflowFile: agent.githubWorkflowFile,
        ref: agent.githubRef || "main",
        ...(matchedRun?.htmlUrl ? { htmlUrl: matchedRun.htmlUrl } : {}),
      },
      ...(matchedRun?.status === "completed" ? { completedAt: new Date().toISOString() } : {}),
    })

    return NextResponse.json({ ok: true, job, run: updatedRun }, { status: 200 })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to dispatch GitHub workflow" }, { status: 400 })
  }
}
