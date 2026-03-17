import { NextResponse } from "next/server"
import { authenticateAgent } from "@/lib/agents-store"
import { applyRepairJobItemUpdate, getRepairJob, updateRepairJob, type RepairJobStatus } from "@/lib/repair-jobs-store"
import { updateMigration } from "@/lib/migrations-store"

function asStatus(value: unknown): RepairJobStatus | undefined {
  return typeof value === "string" && ["pending", "claimed", "running", "completed", "failed", "canceled"].includes(value)
    ? (value as RepairJobStatus)
    : undefined
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
    await authenticateAgent({ agentId: id, token })

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

    const updated = await updateRepairJob(jobId, {
      ...(status ? { status } : {}),
      ...(progress ? { progress } : {}),
      ...(result ? { result } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
      lastHeartbeatAt: now,
      ...(status === "completed" || status === "failed" || status === "canceled" ? { completedAt: now } : {}),
    })

    if (status === "completed") {
      await updateMigration(job.migrationId, {
        syncStatus: "ok",
        syncMessage: summary ?? "Worker reconciliation completed",
        lastSyncedAt: now,
      }).catch(() => undefined)
    } else if (status === "failed") {
      await updateMigration(job.migrationId, {
        status: "failed",
        syncStatus: "error",
        syncMessage: errorMessage ?? summary ?? "Worker reconciliation failed",
        lastSyncedAt: now,
      }).catch(() => undefined)
    } else if (status === "canceled") {
      await updateMigration(job.migrationId, {
        syncStatus: "ok",
        syncMessage: summary ?? "Worker reconciliation aborted",
        lastSyncedAt: now,
      }).catch(() => undefined)
    }

    return NextResponse.json({ ok: true, job: updated })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to update repair job" }, { status: 400 })
  }
}
