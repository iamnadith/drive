import { NextResponse } from "next/server"
import { getProjectApiUsage } from "@/lib/project-operations-store"

export const runtime = "nodejs"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const limitRaw = Number(searchParams.get("limit") ?? 50)
    const result = await getProjectApiUsage({
      projectId: searchParams.get("projectId") ?? undefined,
      action: searchParams.get("action") ?? undefined,
      outcome: searchParams.get("outcome") ?? undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
      limit: Number.isFinite(limitRaw) ? limitRaw : 50,
    })
    return NextResponse.json(result)
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to load API usage") },
      { status: 400 }
    )
  }
}
