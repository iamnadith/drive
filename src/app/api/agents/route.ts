import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createAgent, listAgents, type AgentCapability, type AgentCategory, type AgentProvider } from "@/lib/agents-store"
import { GITHUB_TOKEN_COOKIE } from "@/lib/github-oauth"

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function parseCapabilities(value: unknown): AgentCapability[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => String(entry ?? ""))
    .filter((entry): entry is AgentCapability =>
      ["scan", "verify", "repair", "bulk_migrate", "diagnostics"].includes(entry)
    )
}

export async function GET() {
  try {
    const agents = await listAgents()
    return NextResponse.json({ agents })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to load workers" }, { status: 400 })
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const name = asString(body.name).trim()
    const category = (["worker", "agent"].includes(asString(body.category)) ? asString(body.category) : "worker") as AgentCategory
    const provider = (
      ["self_hosted", "github_actions", "local"].includes(asString(body.provider))
        ? asString(body.provider)
        : "self_hosted"
    ) as AgentProvider
    const capabilities = parseCapabilities(body.capabilities)

    if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 })

    if (provider === "github_actions") {
      if (!asString(body.githubRepoOwner).trim() || !asString(body.githubRepoName).trim() || !asString(body.githubWorkflowFile).trim()) {
        return NextResponse.json(
          { error: "GitHub repo owner, repo name, and workflow file are required for GitHub Actions agents" },
          { status: 400 }
        )
      }
    }

    const cookieStore = await cookies()
    const githubTokenFromCookie = cookieStore.get(GITHUB_TOKEN_COOKIE)?.value ?? ""
    const githubTokenToUse = asString(body.githubToken).trim() || githubTokenFromCookie || undefined

    const result = await createAgent({
      name,
      category,
      provider,
      capabilities,
      endpointDomain: asString(body.endpointDomain).trim() || undefined,
      endpointIp: asString(body.endpointIp).trim() || undefined,
      githubRepoOwner: asString(body.githubRepoOwner).trim() || undefined,
      githubRepoName: asString(body.githubRepoName).trim() || undefined,
      githubWorkflowFile: asString(body.githubWorkflowFile).trim() || undefined,
      githubRef: asString(body.githubRef).trim() || undefined,
      githubRepositoryId: asString(body.githubRepositoryId).trim() || undefined,
      githubToken: githubTokenToUse,
      notes: asString(body.notes).trim() || undefined,
    })

    return NextResponse.json(result, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to create agent/worker" }, { status: 400 })
  }
}
