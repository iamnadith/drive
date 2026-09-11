import { NextResponse } from "next/server"
import { reconcileAndRepairCloudflareWorkers } from "@/lib/cloudflare-worker-installer"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: Request) {
  const secret = String(process.env.CRON_SECRET || "")
  if (secret.length < 16) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 })
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const installation = await reconcileAndRepairCloudflareWorkers(true)
    return NextResponse.json({ ok: installation?.status === "ready", status: installation?.status || "not_configured", step: installation?.step || "none" })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Worker reconciliation failed" }, { status: 500 })
  }
}
