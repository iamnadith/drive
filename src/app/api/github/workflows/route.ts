import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { GITHUB_TOKEN_COOKIE, listGitHubWorkflows } from "@/lib/github-oauth"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export async function GET(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const token = (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value ?? ""
    if (!token) return NextResponse.json({ error: "GitHub is not connected" }, { status: 401 })

    const url = new URL(request.url)
    const owner = url.searchParams.get("owner") ?? ""
    const repo = url.searchParams.get("repo") ?? ""
    if (!owner || !repo) return NextResponse.json({ error: "owner and repo are required" }, { status: 400 })

    const workflows = await listGitHubWorkflows(token, owner, repo)
    return NextResponse.json({ workflows })
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error, "Unable to load GitHub workflows") }, { status: 400 })
  }
}
