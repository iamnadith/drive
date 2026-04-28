import { NextResponse } from "next/server"
import { signup } from "@/lib/auth"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import { sendVerificationEmail } from "@/lib/email-verification"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { name, username, email, password } = body as {
      name?: string
      username?: string
      email?: string
      password?: string
    }

    if (!name || !username || !email || !password) {
      return NextResponse.json(
        { error: "Name, username, email and password are required" },
        { status: 400 }
      )
    }

    const user = await signup({ name, username, email, password })
    await sendVerificationEmail({
      userId: user.id,
      email: user.email,
      name: user.name,
      request,
      purpose: "signup",
    })
    await recordActivity({
      actorUserId: user.id,
      action: "auth.signup",
      entityType: "user",
      entityId: user.id,
      entityLabel: user.name,
      summary: `${user.name} signed up`,
      detail: `${user.email} created a new account.`,
      after: { user },
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({
      requiresVerification: true,
      email: user.email,
      message: "Verification email sent",
    })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to sign up") },
      { status: 400 }
    )
  }
}
