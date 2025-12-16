import { NextResponse } from "next/server"
import { signup } from "@/lib/auth"

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { name, username, email, password } = body as {
      name?: string
      username?: string
      email?: string
      password?: string
    }

    if (!name || !username || !email || !password) {
      return NextResponse.json(
        { error: "Name, username, email and password are required" },
        { status: 400 }
      )
    }

    const user = await signup({ name, username, email, password })

    const response = NextResponse.json({ user })
    response.cookies.set("sessionUserId", user.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    })

    return response
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unable to sign up" },
      { status: 400 }
    )
  }
}
