import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createAgentRun, ensureAgentRegistrationToken, getAgentById, getAgentGithubToken, listAgentRunsByAgentId, updateAgent, updateAgentRun } from "@/lib/agents-store"
import { createRepairJob, findActiveRepairJobForDispatch, listRepairJobs, type RepairJobMode } from "@/lib/repair-jobs-store"
import { GITHUB_TOKEN_COOKIE, listGitHubWorkflowRuns, setGitHubActionsSecret } from "@/lib/github-oauth"
import { listMigrationItems } from "@/lib/migrations-store"

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
  agentId: string
  registrationToken: string
}) {
  await Promise.all([
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
      name: "DRIVE_AGENT_ID",
      value: input.agentId,
    }),
    setGitHubActionsSecret({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      name: "DRIVE_AGENT_TOKEN",
      value: input.registrationToken,
    }),
  ])
}

function isUnexpectedWorkflowInputsError(status: number, text: string): boolean {
  return status === 422 && /unexpected inputs provided/i.test(text)
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
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
    const items = await listMigrationItems(migrationId)
    if (hasActiveSuperSlurper(items)) {
      return NextResponse.json({ error: "Cannot run with worker while Super Slurper is still active for this migration." }, { status: 409 })
    }
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

    if (agent.provider !== "github_actions") {
      const job = await createRepairJob({
        migrationId,
        mode,
        requestedByAgentId: id,
        payload: {
          source: agent.provider,
          agentId: id,
        },
      })

      await updateAgent(id, {
        status: agent.provider === "self_hosted" || agent.provider === "local" ? "online" : agent.status,
        lastError: null,
        metadata: {
          ...(agent.metadata ?? {}),
          activeRepairJobId: job.id,
        },
      }).catch(() => undefined)

      return NextResponse.json({ ok: true, job }, { status: 200 })
    }

    if (!agent.githubRepoOwner || !agent.githubRepoName || !agent.githubWorkflowFile) {
      return NextResponse.json({ error: "GitHub repo owner, repo name, and workflow file are required" }, { status: 400 })
    }
    const githubRepoOwner = agent.githubRepoOwner
    const githubRepoName = agent.githubRepoName
    const githubWorkflowFile = agent.githubWorkflowFile

    const activeWorkerJobs = (await listRepairJobs(100)).filter(
      (job) =>
        !["completed", "failed", "canceled"].includes(job.status) &&
        (job.claimedByAgentId === id || job.requestedByAgentId === id)
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
    const activeDispatchRuns = activeWorkerRuns.filter(
      (run) => run.runType === "github_dispatch" && (run.status === "pending" || run.status === "running")
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

    const registrationToken = await ensureAgentRegistrationToken(id)

    const serverUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || new URL(request.url).origin).replace(/\/+$/, "")
    const dispatchRequestedAt = new Date().toISOString()
    let secretSyncError: string | null = null
    try {
      await syncGitHubWorkerSecrets({
        token: githubToken,
        owner: githubRepoOwner,
        repo: githubRepoName,
        serverUrl,
        agentId: id,
        registrationToken,
      })
    } catch (error: any) {
      secretSyncError = error?.message ? String(error.message) : "Unable to sync GitHub worker secrets"
    }
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
      status: "pending",
      jobReference: job.id,
      summary: `Queued GitHub dispatch for repair job ${job.id}`,
      payload: {
        migrationId,
        mode,
        repoOwner: githubRepoOwner,
        repoName: githubRepoName,
        workflowFile: githubWorkflowFile,
        ref: agent.githubRef || "main",
        dispatchRequestedAt,
      },
    })

    await updateAgent(id, {
      status: "offline",
      lastError: null,
      metadata: {
        ...(agent.metadata ?? {}),
        activeRepairJobId: job.id,
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
            inputs: {
              migration_id: migrationId,
              repair_job_id: job.id,
              agent_id: id,
              ...(includeRuntimeInputs ? { server_url: serverUrl, agent_token: registrationToken } : {}),
              ...dispatchInputs,
            },
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
          response = await dispatchWorkflow(false)
        } else {
          response = new Response(firstBody, { status: response.status, statusText: response.statusText, headers: response.headers })
        }
      }
    } catch (error: any) {
      return NextResponse.json({ error: error?.message ?? "Unable to send GitHub workflow dispatch request" }, { status: 400 })
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "")
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

    const recentRuns = await listGitHubWorkflowRuns({
      token: githubToken,
      owner: githubRepoOwner,
      repo: githubRepoName,
      workflow: githubWorkflowFile,
      branch: agent.githubRef || "main",
      event: "workflow_dispatch",
      perPage: 10,
    }).catch(() => [])

    const matchedRun =
      recentRuns.find((candidate) => String(candidate.displayTitle ?? "").includes(job.id)) ??
      recentRuns.find((candidate) => {
        const createdAt = Date.parse(candidate.createdAt || "")
        const requestedAt = Date.parse(dispatchRequestedAt)
        if (!Number.isFinite(createdAt) || !Number.isFinite(requestedAt)) return false
        return createdAt >= requestedAt - 60_000
      }) ?? recentRuns[0]

    const updatedRun = await updateAgentRun(run.id, {
      status: matchedRun ? (matchedRun.status === "completed" ? "completed" : "running") : "pending",
      externalRunId: matchedRun?.id ?? null,
      summary: matchedRun
        ? `Workflow dispatched for repair job ${job.id} (run #${matchedRun.runNumber ?? matchedRun.id})`
        : `Workflow dispatch queued for repair job ${job.id}; waiting for GitHub to start the run`,
      payload: {
        migrationId,
        mode,
        repoOwner: githubRepoOwner,
        repoName: githubRepoName,
        workflowFile: githubWorkflowFile,
        ref: agent.githubRef || "main",
        dispatchRequestedAt,
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
        activeRepairJobId: matchedRun && matchedRun.status !== "completed" ? job.id : null,
        githubDispatchRequestedAt: dispatchRequestedAt,
        ...(matchedRun?.id ? { githubRunId: matchedRun.id } : {}),
        ...(matchedRun?.status ? { githubRunStatus: matchedRun.status } : {}),
        ...(matchedRun?.conclusion ? { githubRunConclusion: matchedRun.conclusion } : {}),
        ...(matchedRun?.htmlUrl ? { githubRunUrl: matchedRun.htmlUrl } : {}),
      },
    }).catch(() => undefined)

    return NextResponse.json({ ok: true, job, run: updatedRun }, { status: 200 })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to dispatch GitHub workflow" }, { status: 400 })
  }
}
