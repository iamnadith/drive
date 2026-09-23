import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { findUserById, toPublicUser, updateUser } from "@/lib/users-store"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function PATCH(request: Request) {
  try {
    const cookieStore = await cookies()
    const userId = cookieStore.get("sessionUserId")?.value
    if (!userId) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { enabled?: unknown }
    const enabled = body.enabled === true
    const user = await findUserById(userId)
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

    const updated = await updateUser(user.id, { twoFactorEnabled: enabled })
    if (user.twoFactorEnabled !== enabled) {
      await recordActivity({ actorUserId: user.id, action: enabled ? "security.2fa_enabled" : "security.2fa_disabled", entityType: "user", entityId: user.id, entityLabel: user.email, summary: enabled ? "Enabled two-factor authentication" : "Disabled two-factor authentication", before: { enabled: user.twoFactorEnabled }, after: { enabled }, ...getRequestActivityContext(request) })
    }
    return NextResponse.json({ user: toPublicUser(updated) })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to update 2FA") }, { status: 400 })
  }
}
