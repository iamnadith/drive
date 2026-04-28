import { NextResponse } from "next/server"
import { verifyEmailCode } from "@/lib/email-verification"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { email?: unknown; code?: unknown }
    const email = typeof body.email === "string" ? body.email : ""
    const code = typeof body.code === "string" ? body.code : ""
    if (!email || !code) {
      return NextResponse.json({ error: "Email and verification code are required" }, { status: 400 })
    }

    const user = await verifyEmailCode({ email, code, purpose: "signup" })
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
      { error: errorMessage(error, "Unable to verify email") },
      { status: 400 }
    )
  }
}
