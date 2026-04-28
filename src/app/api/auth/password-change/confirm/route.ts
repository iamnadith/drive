import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { verifyEmailCode } from "@/lib/email-verification"
import { findUserById, hashPassword, toPublicUser, updateUser } from "@/lib/users-store"
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
    const cookieStore = await cookies()
    const userId = cookieStore.get("sessionUserId")?.value
    if (!userId) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as {
      code?: unknown
      password?: unknown
      method?: unknown
    }
    const code = typeof body.code === "string" ? body.code : ""
    const password = typeof body.password === "string" ? body.password : ""
    const method = body.method === "sms" ? "sms" : body.method === "authenticator" ? "authenticator" : "email"
    if (!code || !password) {
      return NextResponse.json({ error: "Verification code and password are required" }, { status: 400 })
    }
    if (!passwordIsStrong(password)) {
      return NextResponse.json({ error: "Use 8+ characters with uppercase, lowercase, and a number" }, { status: 400 })
    }

    const user = await findUserById(userId)
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

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
      await verifyEmailCode({ email: user.email, code, purpose: "password-reset" })
    }
    const updated = await updateUser(user.id, {
      passwordHash: hashPassword(password),
      passwordSource: "local",
    })

    return NextResponse.json({ user: toPublicUser(updated) })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to change password") }, { status: 400 })
  }
}
