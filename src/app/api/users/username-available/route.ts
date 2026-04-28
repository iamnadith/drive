import { NextResponse } from "next/server"
import { findUserByUsername } from "@/lib/users-store"

function usernameIsValid(value: string) {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,29}$/.test(value)
}

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

    if (!usernameIsValid(username)) {
      return NextResponse.json(
        { error: "Use 3-30 letters, numbers, dots, dashes, or underscores" },
        { status: 400 }
      )
    }

    const existing = await findUserByUsername(username)
    return NextResponse.json({ available: !existing })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unable to check username")
        : "Unable to check username"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
