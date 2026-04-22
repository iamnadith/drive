import { NextResponse } from "next/server"
import {
  authenticateAgent,
  getAgentGithubToken,
  getLatestAgentRunByJobReference,
  updateAgent,
  updateAgentRun,
} from "@/lib/agents-store"
import { cancelGitHubWorkflowRun, forceCancelGitHubWorkflowRun } from "@/lib/github-oauth"
import { syncMigrationLiveState } from "@/lib/migration-live-state"
import { applyRepairJobItemUpdate, getRepairJob, updateRepairJob, type RepairJobStatus } from "@/lib/repair-jobs-store"
import { updateMigration } from "@/lib/migrations-store"

function asStatus(value: unknown): RepairJobStatus | undefined {
  return typeof value === "string" && ["pending", "claimed", "running", "completed", "failed", "canceled"].includes(value)
    ? (value as RepairJobStatus)
    : undefined
}

function isTerminalRepairStatus(value: RepairJobStatus | undefined): boolean {
  return value === "completed" || value === "failed" || value === "canceled"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getGitHubTokenFallback(): string {
  return (
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  ).trim()
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; jobId: string }> }
) {
  try {
    const { id, jobId } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const token = typeof body.token === "string" ? body.token.trim() : ""
    if (!token) return NextResponse.json({ error: "Registration token is required" }, { status: 400 })
    const agent = await authenticateAgent({ agentId: id, token })

    const job = await getRepairJob(jobId)
    if (!job) return NextResponse.json({ error: "Repair job not found" }, { status: 404 })
    if (job.claimedByAgentId && job.claimedByAgentId !== id) {
      return NextResponse.json({ error: "This job is claimed by another agent" }, { status: 409 })
    }
    if (job.status === "canceled") {
      return NextResponse.json({ ok: true, canceled: true, job })
    }

    const status = asStatus(body.status)
    const progress = typeof body.progress === "object" && body.progress !== null ? (body.progress as Record<string, unknown>) : undefined
    const result = typeof body.result === "object" && body.result !== null ? (body.result as Record<string, unknown>) : undefined
    const summary = typeof body.summary === "string" ? body.summary : undefined
    const errorMessage = typeof body.error === "string" ? body.error : undefined

    if (Array.isArray(body.items)) {
      for (const raw of body.items) {
        if (typeof raw !== "object" || raw === null) continue
        const item = raw as Record<string, unknown>
        const itemId = typeof item.itemId === "string" ? item.itemId : ""
        const stage = typeof item.stage === "string" ? item.stage : "repair_progress"
        const itemStatus = typeof item.status === "string" ? item.status : "running"
        if (!itemId) continue
        await applyRepairJobItemUpdate({
          migrationId: job.migrationId,
          itemId,
          stage,
          status: itemStatus,
          summary: typeof item.summary === "string" ? item.summary : undefined,
          details: typeof item.details === "object" && item.details !== null ? (item.details as Record<string, unknown>) : undefined,
          transferred: typeof item.transferred === "number" ? item.transferred : undefined,
          failed: typeof item.failed === "number" ? item.failed : undefined,
          skipped: typeof item.skipped === "number" ? item.skipped : undefined,
        })
      }
    }

    const now = new Date().toISOString()
    const current = await getRepairJob(jobId)
    if (!current) return NextResponse.json({ error: "Repair job not found" }, { status: 404 })
    if (current.status === "canceled") {
      return NextResponse.json({ ok: true, canceled: true, job: current })
    }

    const mergedProgress =
      progress !== undefined
        ? {
            ...(isRecord(current.progress) ? current.progress : {}),
            ...progress,
          }
        : undefined
    const mergedResult =
      result !== undefined
        ? {
            ...(isRecord(current.result) ? current.result : {}),
            ...result,
          }
        : undefined

    const effectiveStatus = isTerminalRepairStatus(current.status) && !isTerminalRepairStatus(status) ? current.status : status

    const updated = await updateRepairJob(jobId, {
      ...(effectiveStatus ? { status: effectiveStatus } : {}),
      ...(mergedProgress ? { progress: mergedProgress } : {}),
      ...(mergedResult ? { result: mergedResult } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
      lastHeartbeatAt: now,
      ...(effectiveStatus === "completed" || effectiveStatus === "failed" || effectiveStatus === "canceled" ? { completedAt: now } : {}),
    })

    if (effectiveStatus === "completed" || effectiveStatus === "failed" || effectiveStatus === "canceled") {
      const linkedRun = await getLatestAgentRunByJobReference(jobId).catch(() => null)
      if (
        agent.provider === "github_actions" &&
        linkedRun?.externalRunId &&
        agent.githubRepoOwner &&
        agent.githubRepoName
      ) {
        const githubToken = (await getAgentGithubToken(agent.id).catch(() => null)) || getGitHubTokenFallback()
        if (githubToken) {
          await cancelGitHubWorkflowRun({
            token: githubToken,
            owner: agent.githubRepoOwner,
            repo: agent.githubRepoName,
            runId: linkedRun.externalRunId,
          }).catch(() => undefined)
          await forceCancelGitHubWorkflowRun({
            token: githubToken,
            owner: agent.githubRepoOwner,
            repo: agent.githubRepoName,
            runId: linkedRun.externalRunId,
          }).catch(() => undefined)
        }
      }

      if (linkedRun) {
        await updateAgentRun(linkedRun.id, {
          status: effectiveStatus === "completed" ? "completed" : effectiveStatus === "failed" ? "failed" : "canceled",
          completedAt: now,
          summary:
            summary ??
            (effectiveStatus === "completed"
              ? "GitHub workflow completed successfully"
              : effectiveStatus === "failed"
                ? errorMessage ?? "GitHub workflow failed"
                : "GitHub workflow was aborted"),
          payload: {
            ...(linkedRun.payload ?? {}),
            githubStatus: effectiveStatus === "completed" ? "completed" : effectiveStatus === "canceled" ? "completed" : linkedRun.payload?.githubStatus ?? null,
            githubConclusion:
              effectiveStatus === "completed" ? "success" : effectiveStatus === "canceled" ? "cancelled" : linkedRun.payload?.githubConclusion ?? null,
            githubUpdatedAt: now,
          },
        }).catch(() => undefined)
      }

      await updateAgent(id, {
        status: agent.provider === "github_actions" ? "offline" : agent.provider === "self_hosted" || agent.provider === "local" ? "online" : "offline",
        lastError: effectiveStatus === "failed" ? errorMessage ?? summary ?? "Worker reconciliation failed" : null,
        metadata: {
          ...(agent.metadata ?? {}),
          activeRepairJobId: null,
          githubRunStatus: agent.provider === "github_actions" ? "completed" : (agent.metadata ?? {}).githubRunStatus ?? null,
          githubRunConclusion:
            agent.provider === "github_actions"
              ? effectiveStatus === "completed"
                ? "success"
                : effectiveStatus === "canceled"
                  ? "cancelled"
                  : "failure"
              : (agent.metadata ?? {}).githubRunConclusion ?? null,
          githubRunUpdatedAt: agent.provider === "github_actions" ? now : (agent.metadata ?? {}).githubRunUpdatedAt ?? null,
        },
      }).catch(() => undefined)
    }

    if (effectiveStatus === "completed") {
      await updateMigration(job.migrationId, {
        syncStatus: "ok",
        syncMessage: summary ?? "Worker reconciliation completed",
        lastSyncedAt: now,
      }).catch(() => undefined)
    } else if (effectiveStatus === "failed") {
      await updateMigration(job.migrationId, {
        syncStatus: "error",
        syncMessage: errorMessage ?? summary ?? "Worker reconciliation failed",
        lastSyncedAt: now,
      }).catch(() => undefined)
    } else if (effectiveStatus === "canceled") {
      await updateMigration(job.migrationId, {
        syncStatus: "ok",
        syncMessage: summary ?? "Worker reconciliation aborted",
        lastSyncedAt: now,
      }).catch(() => undefined)
    }

    await syncMigrationLiveState(job.migrationId).catch(() => undefined)

    return NextResponse.json({ ok: true, job: updated })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to update repair job" }, { status: 400 })
  }
}
