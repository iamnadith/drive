import { NextRequest, NextResponse } from "next/server"
import { getCloudflareHostingPreference, getCloudflareInstallation, installCloudflareWorkers, revealCloudflareTokens, setCloudflareHostingMode } from "@/lib/cloudflare-worker-installer"
import { requireSuperAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"
export const maxDuration = 300

export async function GET() {
  const session = await requireSuperAdmin(); if (!session.ok) return session.response
  return NextResponse.json({ installation: await getCloudflareInstallation(), hosting: await getCloudflareHostingPreference() })
}

export async function PATCH(request: NextRequest) {
  const session = await requireSuperAdmin(); if (!session.ok) return session.response
  try {
    const body = await request.json() as { mode?: unknown; refreshManual?: unknown; action?: unknown }
    if (body.action === "reveal_tokens") return NextResponse.json({ tokens: await revealCloudflareTokens() }, { headers: { "Cache-Control": "no-store" } })
    if (body.mode !== "automatic" && body.mode !== "manual") throw new Error("Hosting mode must be automatic or manual")
    return NextResponse.json({ hosting: await setCloudflareHostingMode(body.mode, body.refreshManual === true) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to change hosting mode" }, { status: 400 })
  }
}

export async function POST(request: NextRequest) {
  const session = await requireSuperAdmin(); if (!session.ok) return session.response
  try {
    const body = await request.json() as { mode?: unknown; token?: unknown; backendToken?: unknown; scannerToken?: unknown; migrationToken?: unknown; restart?: unknown }
    const mode = body.mode === "separate" ? "separate" : "single"
    const installation = await installCloudflareWorkers({ mode, restart: body.restart === true, tokens: {
      backend: String(mode === "single" ? body.token || "" : body.backendToken || ""),
      scanner: String(body.scannerToken || ""), migration: String(body.migrationToken || ""),
    } })
    return NextResponse.json({ installation })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Installation failed", installation: await getCloudflareInstallation().catch(() => null) }, { status: 400 })
  }
}
