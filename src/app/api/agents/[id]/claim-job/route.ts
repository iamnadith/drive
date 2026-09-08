import { NextResponse } from "next/server"
import { authenticateAgent, getAgentById, listAgentRunsByAgentId, updateAgentRun } from "@/lib/agents-store"
import { buildRepairJobExecutionPayload, claimRepairJob, getMigrationWorkerPoolState, updateRepairJob } from "@/lib/repair-jobs-store"
import { getMigration } from "@/lib/migrations-store"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const token = typeof body.token === "string" ? body.token.trim() : ""
    if (!token) return NextResponse.json({ error: "Worker secret is required" }, { status: 400 })

    await authenticateAgent({ agentId: id, token })
    const agent = await getAgentById(id)
    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 })

    const requestedJobId = typeof body.jobId === "string" ? body.jobId.trim() : ""
    const requestedMigrationId = typeof body.migrationId === "string" ? body.migrationId.trim() : ""
    const requestedPool = body.pool === true
    const githubRunId = typeof body.githubRunId === "string" ? body.githubRunId.trim() : ""
    let boundJobId = requestedJobId
    let poolMigrationId = requestedPool ? requestedMigrationId : ""
    let poolRun: Awaited<ReturnType<typeof listAgentRunsByAgentId>>[number] | null = null

    if (requestedPool && !requestedMigrationId) {
      return NextResponse.json({ error: "Pool worker claim requires migrationId" }, { status: 409 })
    }

    if (agent.provider === "github_actions") {
      if (!githubRunId && !boundJobId) {
        return NextResponse.json({ error: "GitHub worker run identity is required" }, { status: 409 })
      }
      if (githubRunId) {
        const runs = await listAgentRunsByAgentId(id, 50)
        let linkedRun = runs.find((run) => run.externalRunId === githubRunId)
        // GitHub can start a dispatched workflow before the panel's dispatch
        // response has indexed the external run id. A pool worker still has a
        // safe identity here: there must be exactly one active, unbound pool
        // run for this migration. Bind that run once, then continue claiming
        // shards without waiting for a later reconciliation tick.
        if (!linkedRun) {
          const candidates = runs.filter((run) => {
            if (run.runType !== "github_dispatch" || !["pending", "running"].includes(run.status)) return false
            if (run.externalRunId || run.payload?.pool !== true) return false
            const runMigrationId = typeof run.payload?.migrationId === "string" ? run.payload.migrationId.trim() : ""
            return Boolean(requestedMigrationId && runMigrationId === requestedMigrationId)
          })
          if (candidates.length === 1) {
            linkedRun = candidates[0]
            await updateAgentRun(linkedRun.id, { externalRunId: githubRunId }).catch(() => undefined)
          }
        }
        if (!linkedRun) {
          return NextResponse.json({ ok: true, job: null, waitingForRunLink: true }, { status: 200 })
        }
        const linkedPoolRun = linkedRun.payload?.pool === true
        if (linkedPoolRun) {
          poolRun = linkedRun
          const linkedMigrationId = typeof linkedRun.payload?.migrationId === "string" ? linkedRun.payload.migrationId.trim() : ""
          if (poolMigrationId && linkedMigrationId && poolMigrationId !== linkedMigrationId) {
            return NextResponse.json({ error: "GitHub worker run is bound to a different migration" }, { status: 409 })
          }
          poolMigrationId = linkedMigrationId || poolMigrationId
          if (!poolMigrationId) {
            return NextResponse.json({ error: "GitHub worker run is missing its migration scope" }, { status: 409 })
          }
          if (!requestedPool && !poolMigrationId) {
            return NextResponse.json({ error: "GitHub worker pool claim is missing its migration scope" }, { status: 409 })
          }
        } else if (!linkedRun.jobReference) {
          return NextResponse.json({ ok: true, job: null, waitingForRunLink: true }, { status: 200 })
        }
        if (boundJobId && linkedRun.jobReference && boundJobId !== linkedRun.jobReference) {
          return NextResponse.json({ error: "GitHub run does not belong to the requested repair job" }, { status: 409 })
        }
        // A pool run claims a fresh shard on every request. Its previous
        // jobReference is cleared after completion, but do not let a stale
        // reference pin the next claim if that cleanup raced a retry.
        boundJobId = linkedPoolRun ? requestedJobId : linkedRun.jobReference ?? ""
      }
    } else if (!requestedPool && !boundJobId && typeof agent.metadata?.activeRepairJobId === "string") {
      boundJobId = agent.metadata.activeRepairJobId
    } else if (!requestedPool && !boundJobId && typeof agent.metadata?.activeMigrationId === "string") {
      poolMigrationId = agent.metadata.activeMigrationId.trim()
    }

    if (requestedPool && !poolMigrationId) {
      return NextResponse.json({ error: "Pool worker claim requires a migration scope" }, { status: 409 })
    }
    if (poolMigrationId) {
      const poolMigration = await getMigration(poolMigrationId)
      if (!poolMigration || poolMigration.options.executionMode !== "migration_workers") {
        return NextResponse.json({ error: "Pool claim requires an active migration worker migration" }, { status: 409 })
      }
      if (!agent.capabilities.includes("bulk_migrate")) {
        return NextResponse.json({ error: "This worker is not registered for bulk migrations" }, { status: 409 })
      }
    }

    const job = await claimRepairJob(
      id,
      boundJobId || undefined,
      poolMigrationId || undefined,
      Boolean(poolMigrationId)
    )
    if (!job) {
      if (poolMigrationId) {
        const poolState = await getMigrationWorkerPoolState(poolMigrationId)
        if (poolState.done) {
          return NextResponse.json(
            { ok: true, job: null, poolComplete: true, poolStatus: poolState.status ?? null, poolReason: poolState.reason ?? null },
            { status: 200 }
          )
        }
      }
      return NextResponse.json({ ok: true, job: null }, { status: 200 })
    }

    const payload = await buildRepairJobExecutionPayload(job)
    await updateRepairJob(job.id, {
      status: "running",
      progress: { stage: "claimed", agentId: id, claimedAt: new Date().toISOString() },
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      summary: `Claimed by ${agent.name}`,
      expectedAgentId: id,
    })

    if (poolRun) {
      await updateAgentRun(poolRun.id, {
        jobReference: job.id,
        status: "running",
        summary: `Claimed worker-pool job ${job.id}`,
      }).catch(() => undefined)
    }

    return NextResponse.json({ ok: true, job, payload }, { status: 200 })
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to claim repair job" }, { status: 400 })
  }
}
