import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import {
  PublicUser,
  createUser,
  getAllUsers,
  searchUsers,
  toPublicUser,
} from "@/lib/users-store"

export async function GET(request: Request) {
  try {
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
  } catch (error: any) {
    const message = error?.message ?? "Unable to load users"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function POST(request: Request) {
  try {
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

    // Only a super admin can explicitly create a super admin user.
    if (role === "superadmin") {
      const cookieStore = await cookies()
      const actorId = cookieStore.get("sessionUserId")?.value
      const allUsers = await getAllUsers()
      const actor = actorId
        ? allUsers.find((u) => u.id === actorId)
        : undefined

      if (!actor || actor.role !== "superadmin") {
        return NextResponse.json(
          { error: "Only Super Admin can create a Super Admin account" },
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

    return NextResponse.json({ user: toPublicUser(user) })
  } catch (error: any) {
    const message = error?.message ?? "Unable to create user"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
