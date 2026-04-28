import { NextResponse } from "next/server"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import { verifyEmailCode } from "@/lib/email-verification"
import { findUserByEmail } from "@/lib/users-store"
import { verifySmsCode } from "@/lib/sms-verification"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      email?: unknown
      code?: unknown
      method?: unknown
    }
    const email = typeof body.email === "string" ? body.email : ""
    const code = typeof body.code === "string" ? body.code : ""
    const method = body.method === "sms" ? "sms" : "email"
    if (!email || !code) {
      return NextResponse.json({ error: "Email and verification code are required" }, { status: 400 })
    }

    const user =
      method === "sms"
        ? await (async () => {
            const found = await findUserByEmail(email)
            if (!found?.mobileVerified || !found.mobileNumber) {
              throw new Error("SMS verification is not available")
            }
            return verifySmsCode({
              userId: found.id,
              mobileNumber: found.mobileNumber,
              code,
              purpose: "login",
            })
          })()
        : await verifyEmailCode({ email, code, purpose: "login" })
    await recordActivity({
      actorUserId: user.id,
      action: "auth.login",
      entityType: "user",
      entityId: user.id,
      entityLabel: user.name,
      summary: `${user.name} signed in`,
      detail: `User session started after ${method === "sms" ? "SMS" : "email"} OTP verification.`,
      ...getRequestActivityContext(request),
    })

    const response = NextResponse.json({ user })
    response.cookies.set("sessionUserId", user.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    })
    return response
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to verify login") },
      { status: 400 }
    )
  }
}
