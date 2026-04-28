import { NextResponse } from "next/server"
import { verifyEmailCode } from "@/lib/email-verification"
import { findUserByEmail } from "@/lib/users-store"
import { verifySmsCode } from "@/lib/sms-verification"
import { verifyTotpCode } from "@/lib/totp"

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
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
    const code = typeof body.code === "string" ? body.code : ""
    const method = body.method === "sms" ? "sms" : body.method === "authenticator" ? "authenticator" : "email"
    if (!email || !code) {
      return NextResponse.json(
        { error: "Email and verification code are required" },
        { status: 400 }
      )
    }

    if (method === "authenticator") {
      const user = await findUserByEmail(email)
      if (!user?.totpEnabled || !user.totpSecret || !verifyTotpCode(user.totpSecret, code)) {
        return NextResponse.json({ error: "Authenticator code is invalid" }, { status: 400 })
      }
    } else if (method === "sms") {
      const user = await findUserByEmail(email)
      if (!user?.mobileVerified || !user.mobileNumber) {
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
      await verifyEmailCode({ email, code, purpose: "password-reset", consume: false })
    }
    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to verify reset code") },
      { status: 400 }
    )
  }
}
