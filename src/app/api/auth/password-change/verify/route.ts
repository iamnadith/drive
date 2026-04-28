import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { verifyEmailCode } from "@/lib/email-verification"
import { findUserById } from "@/lib/users-store"
import { verifySmsCode } from "@/lib/sms-verification"
import { verifyTotpCode } from "@/lib/totp"

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

    const body = (await request.json().catch(() => ({}))) as {
      code?: unknown
      method?: unknown
    }
    const code = typeof body.code === "string" ? body.code : ""
    const method = body.method === "sms" ? "sms" : body.method === "authenticator" ? "authenticator" : "email"
    if (!code) {
      return NextResponse.json({ error: "Verification code is required" }, { status: 400 })
    }

    const user = await findUserById(userId)
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

    if (method === "authenticator") {
      if (!user.totpEnabled || !user.totpSecret || !verifyTotpCode(user.totpSecret, code)) {
        return NextResponse.json({ error: "Authenticator code is invalid" }, { status: 400 })
      }
    } else if (method === "sms") {
      if (!user.mobileVerified || !user.mobileNumber) {
        return NextResponse.json({ error: "SMS verification is not available" }, { status: 400 })
      }
      await verifySmsCode({
        userId: user.id,
        mobileNumber: user.mobileNumber,
        code,
        purpose: "password-reset",
        consume: false,
      })
    } else {
      await verifyEmailCode({
        email: user.email,
        code,
        purpose: "password-reset",
        consume: false,
      })
    }

    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to verify code") }, { status: 400 })
  }
}
