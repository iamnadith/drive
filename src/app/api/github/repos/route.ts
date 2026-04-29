import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { GITHUB_TOKEN_COOKIE, listGitHubRepos } from "@/lib/github-oauth"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const token = (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value ?? ""
    if (!token) return NextResponse.json({ error: "GitHub is not connected" }, { status: 401 })
    const repos = await listGitHubRepos(token)
    return NextResponse.json({ repos })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to load GitHub repositories") }, { status: 400 })
  }
}
