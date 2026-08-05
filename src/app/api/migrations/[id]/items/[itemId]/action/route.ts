import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import {
  slurperAbortJob,
  slurperGetJobProgress,
  slurperListJobLogs,
  slurperPauseJob,
  slurperResumeJob,
} from "@/lib/cloudflare-r2-super-slurper"
import { createInitialBucketVerifyState } from "@/lib/bucket-verifier"
import {
  getMigration,
  listMigrationItems,
  updateMigration,
  updateMigrationItem,
} from "@/lib/migrations-store"
import { getMigrationReadOnlyState } from "@/lib/migration-read-only"
import { requireAdmin } from "@/lib/server-auth"

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

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; itemId: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response
    const { id, itemId } = await context.params
    const body: unknown = await request.json().catch(() => ({}))
    const data = isRecord(body) ? body : {}
    const action = typeof data.action === "string" ? data.action : ""

    const migration = await getMigration(id)
    if (!migration) {
      return NextResponse.json({ error: "Migration not found" }, { status: 404 })
    }
    const readOnly = getMigrationReadOnlyState(migration)
    if (readOnly.readOnly && action !== "logs" && action !== "progress") {
      return NextResponse.json({ error: `Migration history is read-only: ${readOnly.reason}` }, { status: 409 })
    }

    const items = await listMigrationItems(id)
    const item = items.find((i) => i.id === itemId)
    if (!item) {
      return NextResponse.json({ error: "Migration item not found" }, { status: 404 })
    }

    // If the migration is not running, do not hit Cloudflare for logs/progress.
    // Use the stored DB snapshot instead.
    if (migration.status !== "running" && (action === "logs" || action === "progress")) {
      return NextResponse.json({ ok: true, result: item.progress }, { status: 200 })
    }

    const accounts = await getAllAccounts()
    const target = accounts.find((a) => a.id === migration.targetAccountId)
    if (!target?.cloudflareAccountId) {
      return NextResponse.json({ error: "Target Cloudflare account is not synced" }, { status: 400 })
    }

    // Allow some actions even without a job id (queued/precheck failures).
    if (!item.slurperJobId) {
      if (action === "logs") {
        return NextResponse.json({ ok: true, result: item.progress }, { status: 200 })
      }
      if (action === "verify") {
        if (!isCompletedStatus(item.slurperStatus)) {
          return NextResponse.json({ error: "Bucket must be completed before verification" }, { status: 400 })
        }

        const prefix =
          typeof migration.options?.pathPrefix === "string" && migration.options.pathPrefix.trim().length > 0
            ? migration.options.pathPrefix
            : undefined

        await updateMigrationItem(item.id, {
          progress: {
            ...item.progress,
            stage: "verify_requested",
            verify: createInitialBucketVerifyState({ prefix }),
            destScanId: null,
          },
          lastProgressAt: new Date().toISOString(),
        })

        await updateMigration(id, {
          status: "verifying",
          completedAt: null,
          syncStatus: "ok",
          syncMessage: `Verification started for ${item.sourceBucket}`,
          lastSyncedAt: new Date().toISOString(),
        })

        return NextResponse.json({ ok: true }, { status: 200 })
      }
      if (action === "abort") {
        await updateMigrationItem(item.id, {
          slurperJobId: null,
          slurperStatus: "aborted",
          progress: { ...item.progress, stage: "aborted_without_job", lastAction: { action, at: new Date().toISOString() } },
          lastProgressAt: new Date().toISOString(),
        })
        return NextResponse.json({ ok: true }, { status: 200 })
      }
      if (action === "retry") {
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
            lastAction: { action, at: new Date().toISOString() },
          },
          lastProgressAt: new Date().toISOString(),
        })
        return NextResponse.json({ ok: true }, { status: 200 })
      }

      return NextResponse.json({ error: "No Super Slurper job assigned to this bucket" }, { status: 400 })
    }

    const jobArgs = { accountId: target.cloudflareAccountId, apiToken: target.apiToken, jobId: item.slurperJobId }

    if (action === "pause") {
      const res = await slurperPauseJob(jobArgs)
      await updateMigrationItem(item.id, {
        slurperStatus: "paused",
        progress: { ...item.progress, stage: "paused", lastAction: { action, at: new Date().toISOString() } },
        lastProgressAt: new Date().toISOString(),
      })
      return NextResponse.json({ ok: true, result: res }, { status: 200 })
    }

    if (action === "resume") {
      const res = await slurperResumeJob(jobArgs)
      await updateMigrationItem(item.id, {
        slurperStatus: "running",
        progress: { ...item.progress, stage: "resumed", lastAction: { action, at: new Date().toISOString() } },
        lastProgressAt: new Date().toISOString(),
      })
      return NextResponse.json({ ok: true, result: res }, { status: 200 })
    }

    if (action === "abort") {
      const res = await slurperAbortJob(jobArgs)
      await updateMigrationItem(item.id, {
        slurperStatus: "aborted",
        progress: { ...item.progress, stage: "aborted", lastAction: { action, at: new Date().toISOString() } },
        lastProgressAt: new Date().toISOString(),
      })
      return NextResponse.json({ ok: true, result: res }, { status: 200 })
    }

    if (action === "logs") {
      const res = await slurperListJobLogs(jobArgs)
      await updateMigrationItem(item.id, {
        progress: { ...item.progress, stage: "logs_fetched", logs: res },
        lastProgressAt: new Date().toISOString(),
      })
      return NextResponse.json({ ok: true, result: res }, { status: 200 })
    }

    if (action === "progress") {
      const res = await slurperGetJobProgress(jobArgs)
      await updateMigrationItem(item.id, {
        slurperStatus: res.result?.status ?? item.slurperStatus,
        progress: { ...item.progress, stage: "progress_updated", slurper: res },
        lastProgressAt: new Date().toISOString(),
      })
      return NextResponse.json({ ok: true, result: res }, { status: 200 })
    }

    if (action === "retry") {
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
          lastAction: { action, at: new Date().toISOString() },
        },
        lastProgressAt: new Date().toISOString(),
      })
      return NextResponse.json({ ok: true }, { status: 200 })
    }

    if (action === "verify") {
      if (!isCompletedStatus(item.slurperStatus)) {
        return NextResponse.json({ error: "Bucket must be completed before verification" }, { status: 400 })
      }

      const prefix =
        typeof migration.options?.pathPrefix === "string" && migration.options.pathPrefix.trim().length > 0
          ? migration.options.pathPrefix
          : undefined

      await updateMigrationItem(item.id, {
        progress: {
          ...item.progress,
          stage: "verify_requested",
          verify: createInitialBucketVerifyState({ prefix }),
          destScanId: null,
        },
        lastProgressAt: new Date().toISOString(),
      })

      await updateMigration(id, {
        status: "verifying",
        completedAt: null,
        syncStatus: "ok",
        syncMessage: `Verification started for ${item.sourceBucket}`,
        lastSyncedAt: new Date().toISOString(),
      })

      return NextResponse.json({ ok: true }, { status: 200 })
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unable to perform action")
        : "Unable to perform action"
    return NextResponse.json(
      { error: message },
      { status: 400 }
    )
  }
}
