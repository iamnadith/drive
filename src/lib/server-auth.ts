import { cookies } from "next/headers"
import { NextResponse } from "next/server"

import { findUserById, type User, type UserRole } from "@/lib/users-store"

export type SessionUser = User

export function unauthorized(message = "Authentication required") {
  return NextResponse.json({ error: message }, { status: 401 })
}

export function forbidden(message = "Insufficient permissions") {
  return NextResponse.json({ error: message }, { status: 403 })
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const userId = (await cookies()).get("sessionUserId")?.value
  if (!userId) return null

  const user = await findUserById(userId)
  if (!user || user.status !== "active") return null

  return user
}

export async function requireSessionUser(): Promise<
  | { ok: true; user: SessionUser }
  | { ok: false; response: NextResponse }
> {
  const user = await getSessionUser()
  if (!user) return { ok: false, response: unauthorized() }
  return { ok: true, user }
}

export async function requireRole(roles: UserRole[]): Promise<
  | { ok: true; user: SessionUser }
  | { ok: false; response: NextResponse }
> {
  const session = await requireSessionUser()
  if (!session.ok) return session
  if (!roles.includes(session.user.role)) return { ok: false, response: forbidden() }
  return session
}

export async function requireAdmin() {
  return requireRole(["superadmin", "admin"])
}

export async function requireSuperAdmin() {
  return requireRole(["superadmin"])
}
