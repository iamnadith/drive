import { NextResponse } from "next/server"

import {
  getAmbientThemeSettings,
  normalizeAmbientThemeSettings,
  saveAmbientThemeSettings,
} from "@/lib/ambient-theme-store"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function GET() {
  try {
    const settings = await getAmbientThemeSettings()
    return NextResponse.json({ settings })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to load ambient theme settings")
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function PUT(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const body = (await request.json()) as {
      activeThemeId?: unknown
      themes?: unknown
    }

    const settings = normalizeAmbientThemeSettings(body)
    const saved = await saveAmbientThemeSettings(settings)
    return NextResponse.json({ settings: saved })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to save ambient theme settings")
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
