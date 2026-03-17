import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { GITHUB_TOKEN_COOKIE, listGitHubRepos } from "@/lib/github-oauth"

export async function GET() {
  try {
    const token = (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value ?? ""
    if (!token) return NextResponse.json({ error: "GitHub is not connected" }, { status: 401 })
    const repos = await listGitHubRepos(token)
    return NextResponse.json({ repos })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to load GitHub repositories" }, { status: 400 })
  }
}
