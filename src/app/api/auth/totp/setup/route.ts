import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { findUserById, toPublicUser, updateUser } from "@/lib/users-store"
import { buildTotpUri, generateTotpSecret, verifyTotpCodeWithCounter } from "@/lib/totp"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies()
    const userId = cookieStore.get("sessionUserId")?.value
    if (!userId) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

    const user = await findUserById(userId)
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

    const secret = generateTotpSecret()
    await updateUser(user.id, { totpSecret: secret, totpEnabled: false })
    await recordActivity({ actorUserId: user.id, action: "security.totp_setup_started", entityType: "user", entityId: user.id, entityLabel: user.email, summary: "Started authenticator setup", ...getRequestActivityContext(request) })

    return NextResponse.json({
      secret,
      uri: buildTotpUri({ issuer: "Drive", account: user.email, secret }),
    })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to start 2FA setup") }, { status: 400 })
  }
}

export async function PATCH(request: Request) {
  try {
    const cookieStore = await cookies()
    const userId = cookieStore.get("sessionUserId")?.value
    if (!userId) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as { code?: unknown }
    const code = typeof body.code === "string" ? body.code : ""
    const user = await findUserById(userId)
    if (!user?.totpSecret) return NextResponse.json({ error: "Start 2FA setup first" }, { status: 400 })
    const result = verifyTotpCodeWithCounter(user.totpSecret, code, 0)
    if (!result.valid || result.counter === null) {
      return NextResponse.json({ error: "Authenticator code is invalid" }, { status: 400 })
    }

    const updated = await updateUser(user.id, {
      totpEnabled: true,
      twoFactorEnabled: true,
      totpLastUsedCounter: result.counter,
    })
    await recordActivity({ actorUserId: user.id, action: "security.totp_enabled", entityType: "user", entityId: user.id, entityLabel: user.email, summary: "Enabled authenticator sign-in", ...getRequestActivityContext(request) })
    return NextResponse.json({ user: toPublicUser(updated) })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to enable 2FA") }, { status: 400 })
  }
}

export async function DELETE(request: Request) {
  try {
    const cookieStore = await cookies()
    const userId = cookieStore.get("sessionUserId")?.value
    if (!userId) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

    const user = await findUserById(userId)
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

    const updated = await updateUser(user.id, {
      totpEnabled: false,
      totpSecret: "",
      totpLastUsedCounter: null,
    })
    await recordActivity({ actorUserId: user.id, action: "security.totp_disabled", entityType: "user", entityId: user.id, entityLabel: user.email, summary: "Disabled authenticator sign-in", ...getRequestActivityContext(request) })
    return NextResponse.json({ user: toPublicUser(updated) })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to disable 2FA") }, { status: 400 })
  }
}
