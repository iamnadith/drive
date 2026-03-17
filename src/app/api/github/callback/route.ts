import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { exchangeGitHubCode, GITHUB_FLOW_COOKIE, GITHUB_STATE_COOKIE, GITHUB_TOKEN_COOKIE } from "@/lib/github-oauth"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get("code") ?? ""
  const state = url.searchParams.get("state") ?? ""
  const cookieState = (await cookies()).get(GITHUB_STATE_COOKIE)?.value ?? ""
  const flow = (await cookies()).get(GITHUB_FLOW_COOKIE)?.value ?? "redirect"
  const successRedirect = flow === "popup" ? "/dashboard/workers/github-complete?status=connected" : "/dashboard/workers?github=connected"
  const errorRedirect = flow === "popup" ? "/dashboard/workers/github-complete?status=error" : "/dashboard/workers?github=error"

  if (!code || !state || !cookieState || state !== cookieState) {
    return NextResponse.redirect(new URL(errorRedirect, request.url))
  }

  try {
    const token = await exchangeGitHubCode(code)
    const response = NextResponse.redirect(new URL(successRedirect, request.url))
    response.cookies.set(GITHUB_TOKEN_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 8,
    })
    response.cookies.set(GITHUB_STATE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    })
    response.cookies.set(GITHUB_FLOW_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    })
    return response
  } catch {
    return NextResponse.redirect(new URL(errorRedirect, request.url))
  }
}
