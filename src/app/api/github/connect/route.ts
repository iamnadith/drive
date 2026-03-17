import { NextResponse } from "next/server"
import { buildGitHubOAuthUrl, createGitHubOAuthState, GITHUB_FLOW_COOKIE, GITHUB_STATE_COOKIE } from "@/lib/github-oauth"

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const popup = url.searchParams.get("popup") === "1"
    const state = createGitHubOAuthState()
    const response = NextResponse.redirect(buildGitHubOAuthUrl(state))
    response.cookies.set(GITHUB_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 10,
    })
    response.cookies.set(GITHUB_FLOW_COOKIE, popup ? "popup" : "redirect", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 10,
    })
    return response
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unable to start GitHub OAuth"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
