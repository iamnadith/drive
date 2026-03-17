import { NextResponse } from "next/server"
import { createRepairJob, listRepairJobs, type RepairJobMode } from "@/lib/repair-jobs-store"

export async function GET() {
  try {
    const jobs = await listRepairJobs(100)
    return NextResponse.json({ jobs })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to load repair jobs" }, { status: 400 })
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const migrationId = typeof body.migrationId === "string" ? body.migrationId.trim() : ""
    const mode = (
      typeof body.mode === "string" && ["verify_only", "repair_only", "repair_and_verify"].includes(body.mode)
        ? body.mode
        : "repair_and_verify"
    ) as RepairJobMode
    const requestedByAgentId = typeof body.requestedByAgentId === "string" ? body.requestedByAgentId : undefined

    if (!migrationId) return NextResponse.json({ error: "migrationId is required" }, { status: 400 })
    const job = await createRepairJob({ migrationId, mode, requestedByAgentId })
    return NextResponse.json({ job }, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to create repair job" }, { status: 400 })
  }
}
