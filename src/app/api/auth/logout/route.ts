import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { logout } from "@/lib/auth"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function POST(request: Request) {
  try {
    const actorUserId = (await cookies()).get("sessionUserId")?.value ?? null
    logout()
    await recordActivity({
      actorUserId,
      action: "auth.logout",
      entityType: "user",
      entityId: actorUserId,
      summary: "User signed out",
      detail: "User session ended.",
      ...getRequestActivityContext(request),
    })

    const response = NextResponse.json({ ok: true })
    response.cookies.set("sessionUserId", "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    })

    return response
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to logout") },
      { status: 400 }
    )
  }
}
