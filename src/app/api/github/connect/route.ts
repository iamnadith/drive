import { NextResponse } from "next/server"
import { buildGitHubOAuthUrl, createGitHubOAuthState, GITHUB_STATE_COOKIE } from "@/lib/github-oauth"

export async function GET() {
  try {
    const state = createGitHubOAuthState()
    const response = NextResponse.redirect(buildGitHubOAuthUrl(state))
    response.cookies.set(GITHUB_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 10,
    })
    return response
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to start GitHub OAuth" }, { status: 400 })
  }
}
