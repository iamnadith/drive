import { NextResponse } from "next/server"
import { login } from "@/lib/auth"
import { findUserById, toPublicUser } from "@/lib/users-store"
import { consumeUserTotpCode } from "@/lib/totp-verification"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      identifier?: unknown
      password?: unknown
      code?: unknown
    }
    const identifier = typeof body.identifier === "string" ? body.identifier.trim() : ""
    const password = typeof body.password === "string" ? body.password : ""
    const code = typeof body.code === "string" ? body.code : ""

    if (!identifier || !password || !code) {
      return NextResponse.json(
        { error: "Account, password and authenticator code are required" },
        { status: 400 }
      )
    }

    const publicLoginUser = await login(identifier, password)
    const user = await findUserById(publicLoginUser.id)
    if (!user?.totpEnabled || !user.totpSecret) {
      return NextResponse.json({ error: "Authenticator verification is not enabled" }, { status: 400 })
    }
    if (!(await consumeUserTotpCode(user, code))) {
      return NextResponse.json({ error: "Authenticator code is invalid" }, { status: 400 })
    }

    const publicUser = toPublicUser(user)
    await recordActivity({
      actorUserId: user.id,
      action: "auth.login",
      entityType: "user",
      entityId: user.id,
      entityLabel: user.name,
      summary: `${user.name} signed in`,
      detail: "User session started after authenticator app verification.",
      ...getRequestActivityContext(request),
    })

    const response = NextResponse.json({ user: publicUser })
    response.cookies.set("sessionUserId", user.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    })
    return response
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to verify authenticator code") },
      { status: 400 }
    )
  }
}
