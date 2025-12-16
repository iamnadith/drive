import { NextResponse } from "next/server"
import { signup } from "@/lib/auth"
import {
  hasSuperAdminUser,
  updateUser,
  toPublicUser,
  PublicUser,
} from "@/lib/users-store"

export async function POST(request: Request) {
  try {
    if (await hasSuperAdminUser()) {
      return NextResponse.json(
        { error: "Super admin already initialized" },
        { status: 400 }
      )
    }

    const body = await request.json()
    const { name, username, email, password } = body as {
      name?: string
      username?: string
      email?: string
      password?: string
    }

    if (!name || !username || !email || !password) {
      return NextResponse.json(
        {
          error:
            "Name, username, email and password are required",
        },
        { status: 400 }
      )
    }

    // Use normal signup to create the first user and establish a session.
    const user = await signup({ name, username, email, password })

    // Promote to superadmin and give an unlimited quota (0 MB = unlimited).
    const updated = await updateUser(user.id, {
      role: "superadmin",
      quotaLimitMb: 0,
    })

    const publicUser: PublicUser = toPublicUser(updated)

    const response = NextResponse.json({ user: publicUser })
    response.cookies.set("sessionUserId", publicUser.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    })

    return response
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unable to create admin" },
      { status: 400 }
    )
  }
}
