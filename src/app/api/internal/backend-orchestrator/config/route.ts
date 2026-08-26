import { NextResponse } from "next/server"
import { authenticateBackendOrchestrator } from "@/lib/backend-orchestrator-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function databaseUrl() {
  return (
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    ""
  ).trim()
}

function disablePostgresSsl() {
  const value = String(process.env.DISABLE_POSTGRES_SSL ?? "").trim().toLowerCase()
  return value === "1" || value === "true"
}

export async function GET(request: Request) {
  const auth = await authenticateBackendOrchestrator(request)
  if (!auth.ok) return NextResponse.json({ error: "Invalid Backend Orchestrator secret" }, { status: 401 })
  const postgresUrl = databaseUrl()
  if (!postgresUrl) return NextResponse.json({ error: "Panel PostgreSQL URL is not configured" }, { status: 503 })

  return NextResponse.json(
    {
      version: 2,
      postgresUrl,
      disablePostgresSsl: disablePostgresSsl(),
      syncIntervalMinutes: auth.settings.syncIntervalMinutes,
      retention: { apiEventsDays: 7, objectChangesDays: 7, scanDetailsDays: 7 },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  )
}
