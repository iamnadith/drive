import { NextRequest, NextResponse } from "next/server"
import { getCloudflareHostingPreference, getCloudflareInstallation, installCloudflareWorkers, reconcileCloudflareWorkers, replaceCloudflareTokens, revealCloudflareTokens, setCloudflareHostingMode } from "@/lib/cloudflare-worker-installer"
import { requireSuperAdmin } from "@/lib/server-auth"
import { hasSuperAdminUser } from "@/lib/users-store"
import { getSystemReadiness } from "@/lib/system-readiness"

export const runtime = "nodejs"
export const maxDuration = 300

async function authorizeBootstrap() {
  const session = await requireSuperAdmin()
  if (session.ok) return { ok: true as const, bootstrap: false }
  if (!(await hasSuperAdminUser())) {
    const readiness = await getSystemReadiness()
    if (!readiness.ready) return { ok: false as const, response: NextResponse.json({ error: "Complete required environment setup first" }, { status: 409 }) }
    return { ok: true as const, bootstrap: true }
  }
  return { ok: false as const, response: session.response }
}

export async function GET(request: NextRequest) {
  const auth = await authorizeBootstrap(); if (!auth.ok) return auth.response
  const reconcile = request.nextUrl.searchParams.get("reconcile") === "1"
  return NextResponse.json({ installation: reconcile ? await reconcileCloudflareWorkers(true) : await getCloudflareInstallation(), hosting: await getCloudflareHostingPreference() })
}

export async function PATCH(request: NextRequest) {
  const auth = await authorizeBootstrap(); if (!auth.ok) return auth.response
  try {
    const body = await request.json() as { mode?: unknown; refreshManual?: unknown; action?: unknown; token?: unknown; backendToken?: unknown; scannerToken?: unknown; migrationToken?: unknown }
    if (body.action === "reveal_tokens") {
      if (auth.bootstrap) return NextResponse.json({ error: "Create the Super Admin before revealing saved tokens" }, { status: 403 })
      return NextResponse.json({ tokens: await revealCloudflareTokens() }, { headers: { "Cache-Control": "no-store" } })
    }
    if (body.action === "replace_tokens") {
      if (auth.bootstrap) return NextResponse.json({ error: "Create the Super Admin before replacing saved tokens" }, { status: 403 })
      const mode = body.mode === "separate" ? "separate" : "single"
      return NextResponse.json({ installation: await replaceCloudflareTokens({ mode, tokens: { backend: String(mode === "single" ? body.token || "" : body.backendToken || ""), scanner: String(body.scannerToken || ""), migration: String(body.migrationToken || "") } }) })
    }
    if (body.mode !== "automatic" && body.mode !== "manual") throw new Error("Hosting mode must be automatic or manual")
    return NextResponse.json({ hosting: await setCloudflareHostingMode(body.mode, body.refreshManual === true) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to change hosting mode" }, { status: 400 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizeBootstrap(); if (!auth.ok) return auth.response
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
