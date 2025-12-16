import { NextResponse } from "next/server"
import { login } from "@/lib/auth"

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { email, password } = body as {
      email?: string
      password?: string
    }

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email or username and password are required" },
        { status: 400 }
      )
    }

    const user = await login(email, password)

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
      { error: error?.message ?? "Unable to login" },
      { status: 400 }
    )
  }
}
