import { NextResponse } from "next/server"
import { findUserByEmail } from "@/lib/users-store"

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const raw = searchParams.get("email") ?? ""
    const email = raw.trim()

    if (!email) {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      )
    }

    if (!isValidEmail(email)) {
      return NextResponse.json(
        { error: "Invalid email address" },
        { status: 400 }
      )
    }

    const existing = await findUserByEmail(email)
    return NextResponse.json({ available: !existing })
  } catch (error: any) {
    const message = error?.message ?? "Unable to check email"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
