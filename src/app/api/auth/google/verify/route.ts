import { NextRequest, NextResponse } from "next/server"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import { sendVerificationEmail, verifyEmailCode } from "@/lib/email-verification"
import { sendSmsVerificationCode, verifySmsCode } from "@/lib/sms-verification"
import { findUserById, toPublicUser } from "@/lib/users-store"
import { consumeUserTotpCode } from "@/lib/totp-verification"

type VerificationMethod = "authenticator" | "email" | "sms"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

function normalizeMethod(value: unknown): VerificationMethod {
  return value === "sms" ? "sms" : value === "authenticator" ? "authenticator" : "email"
}

function methodsFor(user: { totpEnabled?: boolean; mobileVerified?: boolean; mobileNumber?: string }): VerificationMethod[] {
  const methods: VerificationMethod[] = []
  if (user.totpEnabled) methods.push("authenticator")
  methods.push("email")
  if (user.mobileVerified && user.mobileNumber) methods.push("sms")
  return methods
}

export async function GET(request: NextRequest) {
  try {
    const userId = request.cookies.get("googleVerifyUserId")?.value
    if (!userId) return NextResponse.json({ error: "No Google verification is pending" }, { status: 401 })
    const user = await findUserById(userId)
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })
    if (user.status !== "active") return NextResponse.json({ error: "User is disabled" }, { status: 403 })
    return NextResponse.json({
      email: user.email,
      methods: methodsFor(user),
      defaultMethod: user.totpEnabled ? "authenticator" : "email",
    })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to load verification") }, { status: 400 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = request.cookies.get("googleVerifyUserId")?.value
    if (!userId) return NextResponse.json({ error: "No Google verification is pending" }, { status: 401 })
    const user = await findUserById(userId)
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })
    if (user.status !== "active") return NextResponse.json({ error: "User is disabled" }, { status: 403 })

    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown
      method?: unknown
      code?: unknown
    }
    const method = normalizeMethod(body.method)
    const action = body.action === "send" ? "send" : "verify"

    if (action === "send") {
      if (method === "authenticator") {
        return NextResponse.json(
          { error: "Authenticator codes are generated in your authenticator app" },
          { status: 400 }
        )
      }
      if (method === "sms") {
        if (!user.mobileVerified || !user.mobileNumber) {
          return NextResponse.json({ error: "SMS verification is not available" }, { status: 400 })
        }
        await sendSmsVerificationCode({ userId: user.id, mobileNumber: user.mobileNumber, purpose: "login" })
      } else {
        await sendVerificationEmail({
          userId: user.id,
          email: user.email,
          name: user.name,
          request,
          purpose: "login",
        })
      }
      return NextResponse.json({
        requiresOtp: true,
        email: user.email,
        method,
        methods: methodsFor(user),
      })
    }

    const code = typeof body.code === "string" ? body.code : ""
    if (method === "authenticator") {
      if (!user.totpEnabled || !user.totpSecret) {
        return NextResponse.json({ error: "Authenticator verification is not enabled" }, { status: 400 })
      }
      if (!(await consumeUserTotpCode(user, code))) {
        return NextResponse.json({ error: "Authenticator code is invalid" }, { status: 400 })
      }
    } else if (method === "sms") {
      if (!user.mobileVerified || !user.mobileNumber) {
        return NextResponse.json({ error: "SMS verification is not available" }, { status: 400 })
      }
      await verifySmsCode({ userId: user.id, mobileNumber: user.mobileNumber, code, purpose: "login" })
    } else {
      await verifyEmailCode({ email: user.email, code, purpose: "login" })
    }

    await recordActivity({
      actorUserId: user.id,
      action: "auth.login",
      entityType: "user",
      entityId: user.id,
      entityLabel: user.name,
      summary: `${user.name} signed in`,
      detail: `User session started after Google sign-in and ${method} verification.`,
      ...getRequestActivityContext(request),
    })

    const response = NextResponse.json({ user: toPublicUser(user) })
    response.cookies.set("sessionUserId", user.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    })
    response.cookies.set("googleVerifyUserId", "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    })
    return response
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to verify Google sign-in") }, { status: 400 })
  }
}
