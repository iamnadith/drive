import { NextResponse } from "next/server"
import { login } from "@/lib/auth"
import { sendVerificationEmail } from "@/lib/email-verification"
import { sendSmsVerificationCode } from "@/lib/sms-verification"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { email, password } = body as {
      email?: string
      password?: string
      verificationMethod?: "email" | "totp" | "sms"
    }

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email or username and password are required" },
        { status: 400 }
      )
    }

    const user = await login(email, password)
    const methods = [
      ...(user.totpEnabled ? ["authenticator"] : []),
      "email",
      ...(user.mobileVerified && user.mobileNumber ? ["sms"] : []),
    ]

    if (!user.twoFactorEnabled) {
      const response = NextResponse.json({ user })
      response.cookies.set("sessionUserId", user.id, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      })
      return response
    }

    if (user.totpEnabled && !body.verificationMethod) {
      return NextResponse.json({
        requiresTotp: true,
        methods,
        message: "Enter your authenticator app code",
      })
    }

    if (body.verificationMethod === "sms") {
      if (!user.mobileVerified || !user.mobileNumber) {
        return NextResponse.json({ error: "SMS verification is not available" }, { status: 400 })
      }
      await sendSmsVerificationCode({
        userId: user.id,
        mobileNumber: user.mobileNumber,
        purpose: "login",
      })
      return NextResponse.json({
        requiresOtp: true,
        email: user.email,
        method: "sms",
        methods,
        message: "SMS verification code sent",
      })
    }

    await sendVerificationEmail({
      userId: user.id,
      email: user.email,
      name: user.name,
      request,
      purpose: "login",
    })

    return NextResponse.json({
      requiresOtp: true,
      email: user.email,
      method: "email",
      methods,
      message: "Verification code sent",
    })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to login") },
      { status: 400 }
    )
  }
}
