import { NextRequest, NextResponse } from "next/server"
import { getCloudflareInstallation, installCloudflareWorkers } from "@/lib/cloudflare-worker-installer"
import { requireSuperAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"
export const maxDuration = 300

export async function GET() {
  const session = await requireSuperAdmin(); if (!session.ok) return session.response
  return NextResponse.json({ installation: await getCloudflareInstallation() })
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
