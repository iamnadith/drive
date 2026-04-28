import { NextResponse } from "next/server"
import crypto from "crypto"
import { createUser, findUserByEmail } from "@/lib/users-store"
import { sendVerificationEmail } from "@/lib/email-verification"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function temporaryPassword() {
  return crypto.randomUUID() + crypto.randomUUID()
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { email?: unknown }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""

    if (!isEmail(email)) {
      return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 })
    }

    const existing = await findUserByEmail(email)
    const hasCompletedSignup = Boolean(existing?.username)
    if (existing?.emailVerified && hasCompletedSignup) {
      return NextResponse.json({ error: "Email already in use" }, { status: 400 })
    }

    const user =
      existing ??
      (await createUser({
        name: email.split("@")[0]?.replace(/[._-]+/g, " ") || "User",
        email,
        password: temporaryPassword(),
        role: "user",
        status: "active",
        emailVerified: false,
        passwordSource: "local",
      }))

    await sendVerificationEmail({
      userId: user.id,
      email: user.email,
      name: user.name,
      request,
      purpose: "signup",
    })

    return NextResponse.json({
      ok: true,
      email: user.email,
      message: "Verification code sent",
    })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to start signup") },
      { status: 400 }
    )
  }
}
