import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { undoActivity } from "@/lib/activity-store"

export const runtime = "nodejs"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    const actorUserId = (await cookies()).get("sessionUserId")?.value ?? null
    await undoActivity(id, actorUserId, request)
    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to undo activity")
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
