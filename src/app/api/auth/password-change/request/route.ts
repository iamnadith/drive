import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { sendVerificationEmail } from "@/lib/email-verification"
import { findUserById } from "@/lib/users-store"
import { sendSmsVerificationCode } from "@/lib/sms-verification"

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

    const body = (await request.json().catch(() => ({}))) as { method?: unknown }
    const method = body.method === "sms" ? "sms" : "email"
    if (method === "sms") {
      if (!user.mobileVerified || !user.mobileNumber) {
        return NextResponse.json({ error: "SMS verification is not available" }, { status: 400 })
      }
      await sendSmsVerificationCode({ userId: user.id, mobileNumber: user.mobileNumber, purpose: "password-reset" })
    } else {
      await sendVerificationEmail({
        userId: user.id,
        email: user.email,
        name: user.name,
        request,
        purpose: "password-reset",
      })
    }

    return NextResponse.json({ ok: true, method, message: "Verification code sent" })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to send verification code") }, { status: 400 })
  }
}
