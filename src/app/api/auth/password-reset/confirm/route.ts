import { NextResponse } from "next/server"
import { verifyEmailCode } from "@/lib/email-verification"
import { findUserByEmail, hashPassword, updateUser } from "@/lib/users-store"
import { verifySmsCode } from "@/lib/sms-verification"
import { consumeUserTotpCode } from "@/lib/totp-verification"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

function passwordIsStrong(value: string) {
  return value.length >= 8 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      email?: unknown
      code?: unknown
      password?: unknown
      method?: unknown
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
    const code = typeof body.code === "string" ? body.code : ""
    const password = typeof body.password === "string" ? body.password : ""
    const method = body.method === "sms" ? "sms" : body.method === "authenticator" ? "authenticator" : "email"
    if (!email || !code || !password) {
      return NextResponse.json(
        { error: "Email, verification code and password are required" },
        { status: 400 }
      )
    }
    if (!passwordIsStrong(password)) {
      return NextResponse.json(
        { error: "Use 8+ characters with uppercase, lowercase, and a number" },
        { status: 400 }
      )
    }

    const user = await findUserByEmail(email)
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    if (method === "authenticator") {
      if (!(await consumeUserTotpCode(user, code))) {
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
      })
    } else {
      await verifyEmailCode({ email, code, purpose: "password-reset" })
    }

    await updateUser(user.id, {
      passwordHash: hashPassword(password),
      passwordSource: "local",
      emailVerified: true,
      emailVerifiedAt: user.emailVerifiedAt ?? new Date().toISOString(),
    })

    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to reset password") },
      { status: 400 }
    )
  }
}
