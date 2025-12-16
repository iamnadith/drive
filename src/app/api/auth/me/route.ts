import { NextRequest, NextResponse } from "next/server"
import { findUserById, toPublicUser } from "@/lib/users-store"

export async function GET(request: NextRequest) {
  const sessionUserId = request.cookies.get("sessionUserId")?.value

  if (!sessionUserId) {
    return NextResponse.json({ user: null })
  }

  const user = await findUserById(sessionUserId)
  if (!user || user.status !== "active") {
    const response = NextResponse.json({ user: null })
    response.cookies.set("sessionUserId", "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    })
    return response
  }

  return NextResponse.json({ user: toPublicUser(user) })
}
