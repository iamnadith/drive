import { NextResponse } from "next/server"
import { listActivity } from "@/lib/activity-store"
import { requireAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function GET(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { searchParams } = new URL(request.url)
    const limitRaw = Number(searchParams.get("limit") ?? 25)
    const undoableParam = searchParams.get("undoable")
    const result = await listActivity({
      q: searchParams.get("q") ?? undefined,
      actorUserId: searchParams.get("actorUserId") ?? undefined,
      action: searchParams.get("action") ?? undefined,
      entityType: searchParams.get("entityType") ?? undefined,
      outcome: searchParams.get("outcome") ?? undefined,
      undoable:
        undoableParam === "true" ? true : undoableParam === "false" ? false : undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
      limit: Number.isFinite(limitRaw) ? limitRaw : 25,
    })
    return NextResponse.json(result)
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to load activity")
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
