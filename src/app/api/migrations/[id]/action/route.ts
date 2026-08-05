import { NextResponse } from "next/server"
import { getAgentById, getAgentGithubToken, getLatestAgentRunByJobReference, updateAgent, updateAgentRun } from "@/lib/agents-store"
import { activateAccountForCompletedMigration, getAllAccounts } from "@/lib/accounts-store"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import { slurperAbortJob, slurperPauseJob, slurperResumeJob } from "@/lib/cloudflare-r2-super-slurper"
import { cancelGitHubWorkflowRun, forceCancelGitHubWorkflowRun, getGitHubWorkflowRun } from "@/lib/github-oauth"
import { getMigration, listMigrationItems, updateMigration, updateMigrationItem } from "@/lib/migrations-store"
import { abortRepairJob, listRepairJobsByMigration } from "@/lib/repair-jobs-store"
import { createInitialBucketVerifyState } from "@/lib/bucket-verifier"
import { requireAdmin } from "@/lib/server-auth"
import { syncMigrationBucketSettings } from "@/lib/migration-settings-sync"
import { getMigrationReadOnlyState, isPermanentAccountCommunicationFailure } from "@/lib/migration-read-only"

export const runtime = "nodejs"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeStatus(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase()
}

function isCompletedStatus(value: string | undefined): boolean {
  const s = normalizeStatus(value)
  return (
    s === "completed" ||
    s === "copy_completed" ||
    s === "complete" ||
    s === "finished" ||
    s === "success" ||
    s === "succeeded"
  )
}

function readVerifyStatus(progress: Record<string, unknown>): "pending" | "running" | "ok" | "error" | null {
  const verify = isRecord(progress.verify) ? (progress.verify as Record<string, unknown>) : null
  if (!verify) return null
  const status = typeof verify.status === "string" ? verify.status : ""
  if (status === "pending" || status === "running" || status === "ok" || status === "error") return status
  return null
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

async function resolveGitHubRunIdForAbort(input: {
  token: string
  owner: string
  repo: string
  workflow?: string
  branch?: string
  externalRunId?: string
}): Promise<string | null> {
  return input.externalRunId ?? null
}

async function abortRepairJobsForMigration(migrationId: string): Promise<{
  abortedJobs: number
  blockedJobs: Array<{ jobId: string; reason: string }>
}> {
  const repairJobs = await listRepairJobsByMigration(migrationId, 50).catch(() => [])
  const activeJobs = repairJobs.filter((job) => ["pending", "claimed", "running"].includes(String(job.status)))
  const blockedJobs: Array<{ jobId: string; reason: string }> = []
  let abortedJobs = 0

  for (const job of activeJobs) {
    await abortRepairJob(job.id).catch(() => undefined)
    abortedJobs += 1
    const linkedRun = await getLatestAgentRunByJobReference(job.id).catch(() => null)
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
        getGitHubTokenFallback()

      if (!githubToken) {
        blockedJobs.push({ jobId: job.id, reason: "No GitHub token available to cancel the workflow run" })
        continue
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
        blockedJobs.push({ jobId: job.id, reason: "Could not find the GitHub workflow run to cancel" })
        continue
      }

      const cancelResult = await ensureGitHubRunCanceled({
        token: githubToken,
        owner: agent.githubRepoOwner,
        repo: agent.githubRepoName,
        runId,
      }).catch(() => null)

      if (!cancelResult) {
        blockedJobs.push({ jobId: job.id, reason: "Unable to confirm GitHub workflow cancellation" })
        continue
      }

      if (cancelResult.status !== "canceled") {
        await updateAgentRun(linkedRun.id, {
          summary: "GitHub workflow abort requested by migration cancel, but cancellation is not confirmed yet",
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

        blockedJobs.push({
          jobId: job.id,
          reason:
            cancelResult.status === "running"
              ? "GitHub accepted the abort request, but the workflow run is still running"
              : cancelResult.status === "failed"
                ? "GitHub workflow ended as failed instead of canceled"
                : "GitHub workflow completed before it could be canceled",
        })
        continue
      }

      await updateAgentRun(linkedRun.id, {
        status: "canceled",
        completedAt: new Date().toISOString(),
        summary: "GitHub workflow abort requested by migration cancel",
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
        },
      }).catch(() => undefined)
    }

  }

  return { abortedJobs, blockedJobs }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const actorUserId = auth.user.id
    const body: unknown = await request.json().catch(() => ({}))
    const data = isRecord(body) ? body : {}
    const action = typeof data.action === "string" ? data.action : ""

    const migration = await getMigration(id)
    if (!migration) return NextResponse.json({ error: "Migration not found" }, { status: 404 })
    const readOnly = getMigrationReadOnlyState(migration)
    if (readOnly.readOnly) {
      return NextResponse.json({ error: `Migration history is read-only: ${readOnly.reason}` }, { status: 409 })
    }

    const items = await listMigrationItems(id)
    const accounts = await getAllAccounts()
    const target = accounts.find((a) => a.id === migration.targetAccountId)
    if (!target?.cloudflareAccountId) {
      return NextResponse.json({ error: "Target Cloudflare account is not synced" }, { status: 400 })
    }

    const now = new Date().toISOString()
    const jobArgsBase = { accountId: target.cloudflareAccountId, apiToken: target.apiToken }

    if (action === "pause_all") {
      const candidates = items.filter((i) => Boolean(i.slurperJobId) && normalizeStatus(i.slurperStatus) === "running")
      for (const item of candidates) {
        await slurperPauseJob({ ...jobArgsBase, jobId: item.slurperJobId! })
        await updateMigrationItem(item.id, {
          slurperStatus: "paused",
          progress: { ...item.progress, stage: "paused_all" },
          lastProgressAt: now,
        })
      }
      await updateMigration(id, { syncStatus: "ok", syncMessage: `Paused ${candidates.length} job(s)`, lastSyncedAt: now })
      return NextResponse.json({ ok: true, paused: candidates.length }, { status: 200 })
    }

    if (action === "resume_all") {
      const candidates = items.filter((i) => Boolean(i.slurperJobId) && normalizeStatus(i.slurperStatus) === "paused")
      for (const item of candidates) {
        await slurperResumeJob({ ...jobArgsBase, jobId: item.slurperJobId! })
        await updateMigrationItem(item.id, {
          slurperStatus: "running",
          progress: { ...item.progress, stage: "resumed_all" },
          lastProgressAt: now,
        })
      }
      await updateMigration(id, { syncStatus: "ok", syncMessage: `Resumed ${candidates.length} job(s)`, lastSyncedAt: now })
      return NextResponse.json({ ok: true, resumed: candidates.length }, { status: 200 })
    }

    if (action === "cancel_migration") {
      const cancelRepairResult = await abortRepairJobsForMigration(id)
      const candidates = items.filter(
        (i) => Boolean(i.slurperJobId) && !["completed", "aborted", "failed", "copy_completed", "copy_failed"].includes(normalizeStatus(i.slurperStatus))
      )
      for (const item of candidates) {
        await slurperAbortJob({ ...jobArgsBase, jobId: item.slurperJobId! })
        await updateMigrationItem(item.id, {
          slurperStatus: "aborted",
          progress: { ...item.progress, stage: "aborted_all" },
          lastProgressAt: now,
        })
      }

      const queuedOrPending = items.filter((i) => !i.slurperJobId && normalizeStatus(i.slurperStatus))
      for (const item of queuedOrPending) {
        await updateMigrationItem(item.id, {
          slurperJobId: null,
          slurperStatus: "aborted",
          progress: { ...item.progress, stage: "aborted_without_job_all" },
          lastProgressAt: now,
        })
      }

      await updateMigration(id, {
        status: "canceled",
        completedAt: now,
        syncStatus: "ok",
        syncMessage: `Migration canceled${cancelRepairResult.abortedJobs > 0 ? `; aborted ${cancelRepairResult.abortedJobs} worker job(s)` : ""}`,
        lastSyncedAt: now,
        options: { ...migration.options, manualCompleted: false, targetActivatedAt: undefined },
      })
      return NextResponse.json({
        ok: true,
        abortedRepairJobs: cancelRepairResult.abortedJobs,
        abortedSlurperJobs: candidates.length,
        remoteCancellationWarnings: cancelRepairResult.blockedJobs,
      }, { status: 200 })
    }

    if (action === "settings_sync") {
      await updateMigration(id, {
        syncStatus: "syncing",
        syncMessage: "Syncing settings",
        lastSyncedAt: now,
      })
      try {
        await syncMigrationBucketSettings(id)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Settings sync failed"
        const failedAt = new Date().toISOString()
        await updateMigration(id, {
          syncStatus: "error",
          syncMessage: message,
          lastSyncedAt: failedAt,
          options: {
            ...migration.options,
            ...(isPermanentAccountCommunicationFailure(message)
              ? {
                  historyReadOnlyAt: failedAt,
                  historyReadOnlyReason: "Cloudflare account communication failed during settings sync",
                }
              : {}),
          },
        })
        return NextResponse.json({ error: message }, { status: 400 })
      }
      const completedAt = new Date().toISOString()
      try {
        await activateAccountForCompletedMigration({ targetAccountId: migration.targetAccountId, completedAt })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Failed to activate migrated account"
        const permanentFailure = isPermanentAccountCommunicationFailure(message)
        await updateMigration(id, {
          status: "completed",
          completedAt,
          syncStatus: "error",
          syncMessage: `Settings synced, but target activation failed: ${message}`,
          lastSyncedAt: completedAt,
          options: {
            ...migration.options,
            targetActivatedAt: undefined,
            ...(permanentFailure
              ? {
                  historyReadOnlyAt: completedAt,
                  historyReadOnlyReason: "Target account activation is unavailable",
                }
              : {}),
          },
        })
        return NextResponse.json({ error: message }, { status: 400 })
      }
      await updateMigration(id, {
        status: "completed",
        completedAt,
        syncStatus: "ok",
        syncMessage: "",
        lastSyncedAt: completedAt,
        options: { ...migration.options, targetActivatedAt: completedAt },
      })
      await recordActivity({
        actorUserId,
        action: "migration.settings_synced",
        entityType: "migration",
        entityId: id,
        entityLabel: `Migration ${id}`,
        summary: "Synchronized settings and completed migration",
        detail: `Applied settings for ${items.length} bucket(s), activated the target account, and completed the migration.`,
        before: { migration },
        after: { bucketCount: items.length, settings: ["publicDevelopmentUrl", "cors"] },
        undoable: false,
        undoReason: "Bucket settings are applied directly to Cloudflare.",
        ...getRequestActivityContext(request),
      })
      return NextResponse.json({ ok: true, syncedBuckets: items.length }, { status: 200 })
    }

    if (action === "mark_completed") {
      await updateMigration(id, {
        status: "verifying",
        completedAt: null,
        syncStatus: "syncing",
        syncMessage: "Syncing settings",
        lastSyncedAt: now,
        options: { ...migration.options, manualCompleted: true, targetActivatedAt: undefined },
      })
      let settingsSyncWarning = ""
      try {
        await syncMigrationBucketSettings(id)
      } catch (error: unknown) {
        settingsSyncWarning = error instanceof Error ? error.message : "Settings sync failed"
      }
      const completedAt = new Date().toISOString()
      let activationError = ""
      try {
        await activateAccountForCompletedMigration({ targetAccountId: migration.targetAccountId, completedAt })
      } catch (error: unknown) {
        activationError = error instanceof Error ? error.message : "Failed to activate migrated account"
      }
      const warning = [settingsSyncWarning, activationError ? `Target activation failed: ${activationError}` : ""]
        .filter(Boolean)
        .join("; ")
      await updateMigration(id, {
        status: "completed",
        completedAt,
        syncStatus: warning ? "error" : "ok",
        syncMessage: warning,
        lastSyncedAt: completedAt,
        options: {
          ...migration.options,
          manualCompleted: true,
          ...(activationError ? { targetActivatedAt: undefined } : { targetActivatedAt: completedAt }),
          ...(isPermanentAccountCommunicationFailure(`${settingsSyncWarning} ${activationError}`)
            ? {
                historyReadOnlyAt: completedAt,
                historyReadOnlyReason: "Cloudflare account communication failed during settings sync",
              }
            : {}),
        },
      })
      const afterAccounts = await getAllAccounts()
      await recordActivity({
        actorUserId,
        action: "migration.completed_activate_target",
        entityType: "migration",
        entityId: id,
        entityLabel: `Migration ${id}`,
        summary: "Marked migration completed and activated target account",
        detail: "Completed migrations permanently activate the target account and disable the previous active account.",
        before: {
          migration,
          accounts: accounts.map((account) => ({
            id: account.id,
            label: account.label,
            status: account.status,
            lastMigrated: account.lastMigrated,
          })),
        },
        after: {
          accounts: afterAccounts.map((account) => ({
            id: account.id,
            label: account.label,
            status: account.status,
            lastMigrated: account.lastMigrated,
          })),
        },
        undoable: false,
        undoReason: "Completed migrations permanently change the active account. Disabled accounts cannot be restored.",
        ...getRequestActivityContext(request),
      })
      return NextResponse.json({ ok: true, ...(warning ? { warning } : {}) }, { status: 200 })
    }

    if (action === "verify_all") {
      const prefix =
        typeof migration.options?.pathPrefix === "string" && migration.options.pathPrefix.trim().length > 0
          ? migration.options.pathPrefix
          : undefined

      const candidates = items.filter((i) => isCompletedStatus(i.slurperStatus))
      for (const item of candidates) {
        await updateMigrationItem(item.id, {
          progress: {
            ...item.progress,
            stage: "verify_requested",
            verify: createInitialBucketVerifyState({ prefix }),
            destScanId: null,
          },
          lastProgressAt: now,
        })
      }

      await updateMigration(id, {
        status: candidates.length > 0 ? "verifying" : migration.status,
        completedAt: null,
        syncStatus: "ok",
        syncMessage: candidates.length > 0 ? `Verification started for ${candidates.length} bucket(s)` : "No completed buckets to verify",
        lastSyncedAt: now,
        options: { ...migration.options, manualCompleted: false, targetActivatedAt: undefined },
      })

      return NextResponse.json({ ok: true, verifying: candidates.length }, { status: 200 })
    }

    if (action === "retry_migration") {
      const candidates = items.filter((item) => {
        const s = normalizeStatus(item.slurperStatus)
        const verifyStatus = readVerifyStatus(
          isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
        )
        if (isCompletedStatus(s)) return verifyStatus === "error"
        return true
      })

      for (const item of candidates) {
        const prevProgress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
        const prevCumulative = isRecord(prevProgress.slurperCumulative)
          ? (prevProgress.slurperCumulative as Record<string, unknown>)
          : null
        const baselineTransferred =
          prevCumulative && typeof prevCumulative.transferredObjects === "number"
            ? prevCumulative.transferredObjects
            : typeof prevProgress.slurperNormalized === "object" &&
                prevProgress.slurperNormalized !== null &&
                typeof (prevProgress.slurperNormalized as Record<string, unknown>).transferredObjects === "number"
              ? ((prevProgress.slurperNormalized as Record<string, unknown>).transferredObjects as number)
              : 0
        const nextRerunCount =
          typeof prevProgress.rerunCount === "number" && Number.isFinite(prevProgress.rerunCount)
            ? Math.max(1, Math.floor(prevProgress.rerunCount) + 1)
            : 1
        await updateMigrationItem(item.id, {
          slurperJobId: null,
          slurperStatus: "queued",
          progress: {
            ...prevProgress,
            stage: "retry_requested",
            rerunNoOverwrite: true,
            rerunCount: nextRerunCount,
            rerunBaselineTransferred: Math.max(0, baselineTransferred),
            error: null,
            lastError: null,
            verify: null,
            verifySamples: null,
            destScanId: null,
            lastAction: { action, at: now },
          },
          lastProgressAt: now,
        })
      }

      await updateMigration(id, {
        status: "running",
        completedAt: null,
        syncStatus: "ok",
        syncMessage:
          candidates.length > 0
            ? `Retry queued for ${candidates.length} bucket(s) with overwrite disabled`
            : "No buckets require retry",
        lastSyncedAt: now,
        options: { ...migration.options, manualCompleted: false, targetActivatedAt: undefined },
      })

      return NextResponse.json({ ok: true, retried: candidates.length }, { status: 200 })
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unable to perform action")
        : "Unable to perform action"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
