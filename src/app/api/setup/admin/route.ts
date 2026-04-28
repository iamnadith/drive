import { NextResponse } from "next/server"
import { signup } from "@/lib/auth"
import {
  hasSuperAdminUser,
  updateUser,
  toPublicUser,
  PublicUser,
} from "@/lib/users-store"
import { sendVerificationEmail } from "@/lib/email-verification"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function POST(request: Request) {
  try {
    if (await hasSuperAdminUser()) {
      return NextResponse.json(
        { error: "Super admin already initialized" },
        { status: 400 }
      )
    }

    const body = await request.json()
    const { name, username, email, password } = body as {
      name?: string
      username?: string
      email?: string
      password?: string
    }

    if (!name || !username || !email || !password) {
      return NextResponse.json(
        {
          error:
            "Name, username, email and password are required",
        },
        { status: 400 }
      )
    }

    // Use normal signup to create the first user and establish a session.
    const user = await signup({ name, username, email, password })

    // Promote to superadmin and give an unlimited quota (0 MB = unlimited).
    const updated = await updateUser(user.id, {
      role: "superadmin",
      quotaLimitMb: 0,
    })

    const publicUser: PublicUser = toPublicUser(updated)
    await sendVerificationEmail({
      userId: publicUser.id,
      email: publicUser.email,
      name: publicUser.name,
      request,
      purpose: "signup",
    })

    return NextResponse.json({
      requiresVerification: true,
      email: publicUser.email,
      message: "Verification email sent",
    })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: errorMessage(error, "Unable to create admin") },
      { status: 400 }
    )
  }
}
