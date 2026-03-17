import { NextResponse } from "next/server"
import { authenticateAgent, getAgentById } from "@/lib/agents-store"
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

    const job = await claimRepairJob(id)
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
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to claim repair job" }, { status: 400 })
  }
}
