import { NextResponse } from "next/server"
import {
  PublicUser,
  createUser,
  searchUsers,
  toPublicUser,
} from "@/lib/users-store"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function GET(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { searchParams } = new URL(request.url)
    const q = searchParams.get("q") ?? undefined
    const roleParam = searchParams.get("role") ?? undefined
    const role =
      roleParam === "admin" ||
      roleParam === "user" ||
      roleParam === "superadmin"
        ? (roleParam as "superadmin" | "admin" | "user")
        : undefined
    const users = await searchUsers(q, role)
    const publicUsers: PublicUser[] = users.map(toPublicUser)
    return NextResponse.json({ users: publicUsers })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to load users")
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const body = await request.json()
    const {
      name,
      username,
      email,
      password,
      role,
      status,
      quotaLimitMb,
      profileImageUrl,
    } = body as {
      name?: string
      username?: string
      email?: string
      password?: string
      role?: "superadmin" | "admin" | "user"
      status?: "active" | "disabled"
      quotaLimitMb?: number
      profileImageUrl?: string
    }

    if (!name || !email || !password) {
      return NextResponse.json(
        { error: "Name, email and password are required" },
        { status: 400 }
      )
    }

    // Only a super admin can create elevated users.
    if (role === "superadmin" || role === "admin") {
      if (auth.user.role !== "superadmin") {
        return NextResponse.json(
          { error: "Only Super Admin can create admin accounts" },
          { status: 403 }
        )
      }
    }

    const user = await createUser({
      name,
      username,
      email,
      password,
      role,
      status,
      quotaLimitMb,
      profileImageUrl,
      passwordSource: "local",
    })
    await recordActivity({
      actorUserId: auth.user.id,
      action: "user.created",
      entityType: "user",
      entityId: user.id,
      entityLabel: user.name,
      summary: `Created user ${user.name}`,
      detail: `${user.email} was created with role ${user.role}.`,
      after: { user: toPublicUser(user) },
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ user: toPublicUser(user) })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to create user")
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
