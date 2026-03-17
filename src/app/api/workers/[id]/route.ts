import { NextResponse } from "next/server"
import { deleteAgent, getAgentById } from "@/lib/agents-store"

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const worker = await getAgentById(id)
    if (!worker) return NextResponse.json({ error: "Worker not found" }, { status: 404 })

    await deleteAgent(id)
    return NextResponse.json({ ok: true })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to delete worker" }, { status: 400 })
  }
}
