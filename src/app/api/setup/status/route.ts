import { NextResponse } from "next/server"
import {
  hasAnyUsers,
  hasAdminUser,
  hasSuperAdminUser,
} from "@/lib/users-store"

export async function GET() {
  const hasUsers = await hasAnyUsers()
  const hasAdmin = await hasAdminUser()
  const hasSuperAdmin = await hasSuperAdminUser()
  return NextResponse.json({ hasUsers, hasAdmin, hasSuperAdmin })
}
