import { NextResponse } from "next/server"
import { logout } from "@/lib/auth"

export async function POST() {
  try {
    logout()

    const response = NextResponse.json({ ok: true })
    response.cookies.set("sessionUserId", "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    })

    return response
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unable to logout" },
      { status: 400 }
    )
  }
}
