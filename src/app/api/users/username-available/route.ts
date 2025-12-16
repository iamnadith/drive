import { NextResponse } from "next/server"
import { findUserByUsername } from "@/lib/users-store"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const raw = searchParams.get("username") ?? ""
    const username = raw.trim()

    if (!username) {
      return NextResponse.json(
        { error: "Username is required" },
        { status: 400 }
      )
    }

    if (username.includes("@")) {
      return NextResponse.json(
        { error: "Username cannot be an email address" },
        { status: 400 }
      )
    }

    const existing = await findUserByUsername(username)
    return NextResponse.json({ available: !existing })
  } catch (error: any) {
    const message = error?.message ?? "Unable to check username"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
