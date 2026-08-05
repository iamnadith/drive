import { NextResponse } from "next/server"
import { authenticateAgent, getAgentById, listAgentRunsByAgentId } from "@/lib/agents-store"
import { buildRepairJobExecutionPayload, claimRepairJob, updateRepairJob } from "@/lib/repair-jobs-store"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const token = typeof body.token === "string" ? body.token.trim() : ""
    if (!token) return NextResponse.json({ error: "Registration token is required" }, { status: 400 })

    await authenticateAgent({ agentId: id, token })
    const agent = await getAgentById(id)
    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 })

    const requestedJobId = typeof body.jobId === "string" ? body.jobId.trim() : ""
    const githubRunId = typeof body.githubRunId === "string" ? body.githubRunId.trim() : ""
    let boundJobId = requestedJobId

    if (agent.provider === "github_actions") {
      if (!githubRunId && !boundJobId) {
        return NextResponse.json({ error: "GitHub worker run identity is required" }, { status: 409 })
      }
      if (githubRunId) {
        const runs = await listAgentRunsByAgentId(id, 50)
        const linkedRun = runs.find((run) => run.externalRunId === githubRunId)
        if (!linkedRun?.jobReference) {
          return NextResponse.json({ ok: true, job: null, waitingForRunLink: true }, { status: 200 })
        }
        if (boundJobId && boundJobId !== linkedRun.jobReference) {
          return NextResponse.json({ error: "GitHub run does not belong to the requested repair job" }, { status: 409 })
        }
        boundJobId = linkedRun.jobReference
      }
    } else if (!boundJobId && typeof agent.metadata?.activeRepairJobId === "string") {
      boundJobId = agent.metadata.activeRepairJobId
    }

    const job = await claimRepairJob(id, boundJobId || undefined)
    if (!job) {
      return NextResponse.json({ ok: true, job: null }, { status: 200 })
    }

    const payload = await buildRepairJobExecutionPayload(job)
    await updateRepairJob(job.id, {
      status: "running",
      progress: { stage: "claimed", agentId: id, claimedAt: new Date().toISOString() },
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      summary: `Claimed by ${agent.name}`,
    })

    return NextResponse.json({ ok: true, job, payload }, { status: 200 })
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to claim repair job" }, { status: 400 })
  }
}
