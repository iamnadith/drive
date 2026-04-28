import { NextResponse } from "next/server"
import { findUserByEmail, findUserByUsername } from "@/lib/users-store"

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function usernameIsValid(value: string) {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,29}$/.test(value)
}

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const identifier = (searchParams.get("identifier") ?? "").trim()
    if (!identifier) {
      return NextResponse.json({ error: "Email or username is required" }, { status: 400 })
    }

    if (identifier.includes("@")) {
      if (!isValidEmail(identifier)) {
        return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 })
      }
      const user = await findUserByEmail(identifier)
      return NextResponse.json({ exists: Boolean(user) })
    }

    if (!usernameIsValid(identifier)) {
      return NextResponse.json({ error: "Enter a valid username" }, { status: 400 })
    }

    const user = await findUserByUsername(identifier)
    return NextResponse.json({ exists: Boolean(user) })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to check account") }, { status: 400 })
  }
}
