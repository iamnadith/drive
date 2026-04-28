import { NextResponse } from "next/server"
import { sendVerificationEmail } from "@/lib/email-verification"
import { findUserByEmail, findUserByUsername } from "@/lib/users-store"
import { sendSmsVerificationCode } from "@/lib/sms-verification"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function usernameIsValid(value: string) {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,29}$/.test(value)
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      identifier?: unknown
      email?: unknown
      method?: unknown
    }
    const identifier =
      typeof body.identifier === "string"
        ? body.identifier.trim()
        : typeof body.email === "string"
          ? body.email.trim()
          : ""
    if (!identifier) {
      return NextResponse.json({ error: "Email or username is required" }, { status: 400 })
    }
    if (identifier.includes("@") && !isValidEmail(identifier)) {
      return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 })
    }
    if (!identifier.includes("@") && !usernameIsValid(identifier)) {
      return NextResponse.json({ error: "Enter a valid username" }, { status: 400 })
    }

    const user = identifier.includes("@")
      ? await findUserByEmail(identifier)
      : await findUserByUsername(identifier)

    if (!user) {
      return NextResponse.json(
        { error: "There is no account with that email or username" },
        { status: 404 }
      )
    }

    const methods = [
      ...(user.totpEnabled ? ["authenticator"] : []),
      "email",
      ...(user.mobileVerified && user.mobileNumber ? ["sms"] : []),
    ]
    const defaultMethod = user.totpEnabled ? "authenticator" : "email"
    const requestedMethod =
      body.method === "sms" ? "sms" : body.method === "authenticator" ? "authenticator" : body.method === "email" ? "email" : defaultMethod

    if (requestedMethod === "sms") {
      if (!user.mobileVerified || !user.mobileNumber) {
        return NextResponse.json({ error: "SMS verification is not available" }, { status: 400 })
      }
      await sendSmsVerificationCode({
        userId: user.id,
        mobileNumber: user.mobileNumber,
        purpose: "password-reset",
      })
    } else if (requestedMethod === "email") {
      await sendVerificationEmail({
        userId: user.id,
        email: user.email,
        name: user.name,
        request,
        purpose: "password-reset",
      })
    }

    return NextResponse.json({
      ok: true,
      email: user.email,
      methods,
      defaultMethod,
      method: requestedMethod,
      sent: requestedMethod !== "authenticator",
      message: "Password reset code sent.",
    })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to send reset code") },
      { status: 400 }
    )
  }
}
