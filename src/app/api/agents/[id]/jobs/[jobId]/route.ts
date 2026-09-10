import { after, NextResponse } from "next/server"
import {
  authenticateAgent,
  getAgentGithubToken,
  getLatestAgentRunByJobReference,
  updateAgent,
  updateAgentRun,
} from "@/lib/agents-store"
import { cancelGitHubWorkflowRun, forceCancelGitHubWorkflowRun } from "@/lib/github-oauth"
import { syncMigrationLiveState } from "@/lib/migration-live-state"
import { applyRepairJobItemUpdate, finalizeCompletedMigrationWorkerShards, getRepairJob, updateRepairJob, type RepairJobStatus } from "@/lib/repair-jobs-store"
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
    if (!token) return NextResponse.json({ error: "Worker secret is required" }, { status: 400 })
    const agent = await authenticateAgent({ agentId: id, token })

    const job = await getRepairJob(jobId)
    if (!job) return NextResponse.json({ error: "Repair job not found" }, { status: 404 })
    if (job.claimedByAgentId !== id) {
      return NextResponse.json({ error: "This job is no longer owned by this worker" }, { status: 409 })
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
          repairJobId: jobId,
          stage,
          status: itemStatus,
          summary: typeof item.summary === "string" ? item.summary : undefined,
          details: typeof item.details === "object" && item.details !== null ? (item.details as Record<string, unknown>) : undefined,
          transferred: typeof item.transferred === "number" ? item.transferred : undefined,
          failed: typeof item.failed === "number" ? item.failed : undefined,
          skipped: typeof item.skipped === "number" ? item.skipped : undefined,
          expectedAgentId: id,
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
    const activeWorkerUpdate = effectiveStatus === "pending" || effectiveStatus === "claimed" || effectiveStatus === "running"
    const hasStaleOfflineMessage =
      current.error === "Self-hosted worker is offline. Start the worker and run the job again." ||
      current.summary === "Self-hosted worker went offline before the job completed"

    const updated = await updateRepairJob(jobId, {
      ...(effectiveStatus ? { status: effectiveStatus } : {}),
      ...(mergedProgress ? { progress: mergedProgress } : {}),
      ...(mergedResult ? { result: mergedResult } : {}),
      ...(summary !== undefined ? { summary } : activeWorkerUpdate && hasStaleOfflineMessage ? { summary: null } : {}),
      ...(errorMessage !== undefined ? { error: errorMessage } : activeWorkerUpdate && hasStaleOfflineMessage ? { error: null } : {}),
      lastHeartbeatAt: now,
      ...(effectiveStatus === "completed" || effectiveStatus === "failed" || effectiveStatus === "canceled" ? { completedAt: now } : {}),
      expectedAgentId: id,
    })

    if (effectiveStatus === "completed" || effectiveStatus === "failed" || effectiveStatus === "canceled") {
      const linkedRun = await getLatestAgentRunByJobReference(jobId).catch(() => null)
      // A GitHub pool workflow is a long-lived dispatcher. Its run is linked
      // to the file currently being processed only so the next claim can be
      // scoped to the same run. Completing one file must release that link
      // and keep the workflow alive for the next file.
      const keepPoolRunAlive =
        effectiveStatus !== "canceled" &&
        (job.payload?.kind === "migration_inventory_file" || job.payload?.kind === "migration_shard") &&
        typeof job.workKey === "string" &&
        (job.workKey.includes(":inventory:") || job.workKey.includes(":shard:")) &&
        linkedRun?.payload?.pool === true

      if (
        !keepPoolRunAlive &&
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
        if (keepPoolRunAlive) {
          await updateAgentRun(linkedRun.id, {
            status: "running",
            jobReference: null,
            completedAt: null,
            summary: `Migration file ${effectiveStatus}; waiting for the next file`,
            payload: {
              ...(linkedRun.payload ?? {}),
              pool: true,
              githubStatus: "in_progress",
              githubConclusion: null,
              githubUpdatedAt: now,
            },
          }).catch(() => undefined)
        } else {
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
      }

      await updateAgent(id, {
        status: keepPoolRunAlive
          ? "online"
          : agent.provider === "github_actions"
            ? "offline"
            : agent.provider === "self_hosted" || agent.provider === "local"
              ? "online"
              : "offline",
        lastError: effectiveStatus === "failed" ? errorMessage ?? summary ?? "Worker reconciliation failed" : null,
        metadata: {
          ...(agent.metadata ?? {}),
          activeRepairJobId: null,
          githubRunStatus: keepPoolRunAlive ? "in_progress" : agent.provider === "github_actions" ? "completed" : (agent.metadata ?? {}).githubRunStatus ?? null,
          githubRunConclusion:
            keepPoolRunAlive
              ? null
              : agent.provider === "github_actions"
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

    if (effectiveStatus === "completed" && job.workKey?.includes(":shard:")) {
      // The cron orchestrator is the recovery backstop, but the final shard
      // update should complete a migration immediately when all peers are
      // already terminal. This keeps the worker lane flowing even when the
      // scheduler is temporarily disabled or delayed.
      await finalizeCompletedMigrationWorkerShards(job.migrationId).catch(() => undefined)
    }
    await syncMigrationLiveState(job.migrationId).catch(() => undefined)
    if (effectiveStatus === "completed") {
      after(async () => {
        await syncMigrationLiveState(job.migrationId, { runSettingsSync: true }).catch(() => undefined)
      })
    }

    return NextResponse.json({ ok: true, job: updated })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to update repair job" },
      { status: 400 }
    )
  }
}
