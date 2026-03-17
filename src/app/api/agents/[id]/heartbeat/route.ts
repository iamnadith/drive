import { NextResponse } from "next/server"
import { recordAgentHeartbeat, type AgentCapability } from "@/lib/agents-store"

function getRemoteIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0]?.trim() || null
  return request.headers.get("x-real-ip")
}

function parseCapabilities(value: unknown): AgentCapability[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => String(entry ?? ""))
    .filter((entry): entry is AgentCapability =>
      ["scan", "verify", "repair", "bulk_migrate", "diagnostics"].includes(entry)
    )
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const token = typeof body.token === "string" ? body.token.trim() : ""

    if (!token) {
      return NextResponse.json({ error: "Registration token is required" }, { status: 400 })
    }

    const agent = await recordAgentHeartbeat({
      agentId: id,
      token,
      remoteIp: getRemoteIp(request),
      host: typeof body.host === "string" ? body.host : null,
      version: typeof body.version === "string" ? body.version : null,
      capabilities: parseCapabilities(body.capabilities),
      metadata: typeof body.metadata === "object" && body.metadata !== null ? (body.metadata as Record<string, unknown>) : {},
    })

    return NextResponse.json({ ok: true, agent })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "Unable to record heartbeat" }, { status: 400 })
  }
}
