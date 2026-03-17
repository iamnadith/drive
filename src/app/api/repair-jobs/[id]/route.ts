import { NextResponse } from "next/server"
import { abortRepairJob, deleteRepairJob, getRepairJob } from "@/lib/repair-jobs-store"

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const job = await getRepairJob(id)
    if (!job) return NextResponse.json({ error: "Repair job not found" }, { status: 404 })
    return NextResponse.json({ job })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to load repair job" }, { status: 400 })
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = typeof body.action === "string" ? body.action : ""
    if (action !== "abort") {
      return NextResponse.json({ error: "Unsupported repair job action" }, { status: 400 })
    }

    const job = await abortRepairJob(id)
    return NextResponse.json({ ok: true, job })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to update repair job" }, { status: 400 })
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const job = await getRepairJob(id)
    if (!job) return NextResponse.json({ error: "Repair job not found" }, { status: 404 })

    await deleteRepairJob(id)
    return NextResponse.json({ ok: true })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to delete repair job" }, { status: 400 })
  }
}
