import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { slurperAbortJob, slurperPauseJob, slurperResumeJob } from "@/lib/cloudflare-r2-super-slurper"
import { getMigration, listMigrationItems, updateMigration, updateMigrationItem } from "@/lib/migrations-store"
import { createInitialBucketVerifyState } from "@/lib/bucket-verifier"

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

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const body: unknown = await request.json().catch(() => ({}))
    const data = isRecord(body) ? body : {}
    const action = typeof data.action === "string" ? data.action : ""

    const migration = await getMigration(id)
    if (!migration) return NextResponse.json({ error: "Migration not found" }, { status: 404 })

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
        syncMessage: "Migration canceled",
        lastSyncedAt: now,
      })
      return NextResponse.json({ ok: true }, { status: 200 })
    }

    if (action === "mark_completed") {
      if (migration.status === "verifying") {
        return NextResponse.json(
          { error: "Cannot mark completed while migration is verifying" },
          { status: 400 }
        )
      }
      await updateMigration(id, {
        status: "completed",
        completedAt: now,
        syncStatus: "ok",
        // Keep completed as completed everywhere; no extra message needed.
        syncMessage: "",
        lastSyncedAt: now,
      })
      return NextResponse.json({ ok: true }, { status: 200 })
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
