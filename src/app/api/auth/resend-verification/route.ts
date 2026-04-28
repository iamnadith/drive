import { NextResponse } from "next/server"
import { findUserByEmail } from "@/lib/users-store"
import { sendVerificationEmail } from "@/lib/email-verification"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { email?: unknown; purpose?: unknown }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
    const purpose = body.purpose === "login" ? "login" : "signup"
    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 })
    }

    const user = await findUserByEmail(email)
    if (user && (purpose === "login" || !user.emailVerified)) {
      await sendVerificationEmail({
        userId: user.id,
        email: user.email,
        name: user.name,
        request,
        purpose,
      })
    }

    return NextResponse.json({
      ok: true,
      message: "If this email needs verification, a new code has been sent.",
    })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to send verification email") },
      { status: 400 }
    )
  }
}
