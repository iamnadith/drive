import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { GITHUB_TOKEN_COOKIE, GitHubApiError } from "@/lib/github-oauth"
import { advanceWorkerSetup } from "@/lib/github-worker-setup"
import { requireAdmin } from "@/lib/server-auth"

export const maxDuration = 120

export async function POST(request: Request) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 })
  }
  const token = (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value
  if (!token) return NextResponse.json({ error: "Connect GitHub first" }, { status: 401 })
  try {
    const body = await request.json() as { cursor?: unknown; selectedId?: unknown }
    const result = await advanceWorkerSetup(token, typeof body.cursor === "string" ? body.cursor : undefined, typeof body.selectedId === "string" ? body.selectedId : undefined)
    return NextResponse.json(result, { status: result.status === "pending" ? 202 : 200 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Worker setup failed" }, {
      status: error instanceof GitHubApiError ? error.status >= 500 ? 502 : error.status : 400,
    })
  }
}
