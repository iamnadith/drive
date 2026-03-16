import { NextResponse } from "next/server"
import {
  hasAnyUsers,
  hasAdminUser,
  hasSuperAdminUser,
} from "@/lib/users-store"

export const runtime = "nodejs"

export async function GET() {
  try {
    const hasUsers = await hasAnyUsers()
    const hasAdmin = await hasAdminUser()
    const hasSuperAdmin = await hasSuperAdminUser()
    return NextResponse.json({ hasUsers, hasAdmin, hasSuperAdmin })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Setup status check failed")
        : "Setup status check failed"

    // Avoid breaking the UI if Supabase is temporarily unreachable.
    return NextResponse.json(
      { hasUsers: false, hasAdmin: false, hasSuperAdmin: false, error: message },
      { status: 200 }
    )
  }
}
