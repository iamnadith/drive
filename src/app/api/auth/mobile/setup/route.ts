import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { findUserById, toPublicUser, updateUser } from "@/lib/users-store"
import { normalizeSriLankaMobile, sendSmsVerificationCode, verifySmsCode } from "@/lib/sms-verification"

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

    const body = (await request.json().catch(() => ({}))) as { mobileNumber?: unknown }
    const mobileNumber = normalizeSriLankaMobile(typeof body.mobileNumber === "string" ? body.mobileNumber : "")
    const user = await findUserById(userId)
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

    await sendSmsVerificationCode({ userId: user.id, mobileNumber, purpose: "mobile-setup" })
    return NextResponse.json({ ok: true, mobileNumber })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to send SMS code") }, { status: 400 })
  }
}

export async function PATCH(request: Request) {
  try {
    const cookieStore = await cookies()
    const userId = cookieStore.get("sessionUserId")?.value
    if (!userId) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

    const body = (await request.json().catch(() => ({}))) as {
      mobileNumber?: unknown
      code?: unknown
    }
    const mobileNumber = normalizeSriLankaMobile(typeof body.mobileNumber === "string" ? body.mobileNumber : "")
    const code = typeof body.code === "string" ? body.code : ""
    const user = await verifySmsCode({ userId, mobileNumber, code, purpose: "mobile-setup" })
    return NextResponse.json({ user })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to verify SMS code") }, { status: 400 })
  }
}

export async function DELETE() {
  try {
    const cookieStore = await cookies()
    const userId = cookieStore.get("sessionUserId")?.value
    if (!userId) return NextResponse.json({ error: "Authentication required" }, { status: 401 })
    const user = await findUserById(userId)
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })
    const updated = await updateUser(user.id, {
      mobileNumber: "",
      mobileVerified: false,
      mobileVerifiedAt: "",
    })
    return NextResponse.json({ user: toPublicUser(updated) })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to remove mobile number") }, { status: 400 })
  }
}
