import { NextResponse } from "next/server"
import { authCapabilities } from "@/lib/system-readiness"

export const runtime = "nodejs"

export async function GET() {
  return NextResponse.json(authCapabilities(), { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } })
}
