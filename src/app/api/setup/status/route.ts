import { NextRequest, NextResponse } from "next/server"
import {
  hasAnyUsers,
  hasAdminUser,
  hasSuperAdminUser,
} from "@/lib/users-store"
import { getSessionUser } from "@/lib/server-auth"
import { cloudflareInstallationReady, getCloudflareInstallation, reconcileCloudflareWorkers } from "@/lib/cloudflare-worker-installer"
import { getSystemReadiness } from "@/lib/system-readiness"
import { queryDb } from "@/lib/db"
import { cookies } from "next/headers"

export const runtime = "nodejs"

function setupResponse(payload: Record<string, unknown>) {
  const response = NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } })
  if (typeof payload.setupRequired === "boolean") {
    response.cookies.set("drive_setup_required", payload.setupRequired ? "1" : "0", {
      sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30,
    })
  }
  return response
}

export async function GET(request: NextRequest) {
  const readiness = await getSystemReadiness()
  try {
    const hasUsers = await hasAnyUsers()
    const hasAdmin = await hasAdminUser()
    const hasSuperAdmin = await hasSuperAdminUser()
    const session = await getSessionUser().catch(() => null)
    const mayManageSetup = !hasSuperAdmin || session?.role === "superadmin"
    const mayInspectWorkers = readiness.ready && mayManageSetup
    const forceWorkers = request.nextUrl.searchParams.get("forceWorkers") === "1"
    const installation = mayInspectWorkers ? await reconcileCloudflareWorkers(forceWorkers).catch(() => getCloudflareInstallation()) : null
    const workersReady = cloudflareInstallationReady(installation)
    const setupStep = !mayManageSetup ? "complete" : !readiness.ready ? "requirements" : !workersReady ? "workers" : !hasSuperAdmin ? "account" : "complete"
    return setupResponse({ hasUsers, hasAdmin, hasSuperAdmin, readiness, workersReady, setupStep, setupRequired: setupStep !== "complete" })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Setup status check failed")
        : "Setup status check failed"

    // Supabase REST may be temporarily unavailable even though PostgreSQL is
    // healthy. Fall back to the same durable user table so an existing site is
    // never mistaken for a brand-new installation.
    try {
      const result = await queryDb<{ has_users: boolean; has_admin: boolean; has_superadmin: boolean }>(`select
        exists(select 1 from drive_users) has_users,
        exists(select 1 from drive_users where role='admin' and status='active') has_admin,
        exists(select 1 from drive_users where role='superadmin' and status='active') has_superadmin`)
      const fallback = result.rows[0]
      const sessionUserId = (await cookies()).get("sessionUserId")?.value
      const session = sessionUserId ? await queryDb<{ role: string }>(`select role from drive_users where id=$1 and status='active' limit 1`, [sessionUserId]) : null
      const mayManageSetup = !fallback?.has_superadmin || session?.rows[0]?.role === "superadmin"
      const installation = readiness.ready && mayManageSetup ? await getCloudflareInstallation().catch(() => null) : null
      const workersReady = cloudflareInstallationReady(installation)
      const setupStep = !mayManageSetup ? "complete" : !readiness.ready ? "requirements" : !workersReady ? "workers" : !fallback?.has_superadmin ? "account" : "complete"
      return setupResponse({ hasUsers: fallback?.has_users === true, hasAdmin: fallback?.has_admin === true, hasSuperAdmin: fallback?.has_superadmin === true, readiness, workersReady, setupStep, setupRequired: setupStep !== "complete", warning: message })
    } catch { /* Database readiness card will carry the actionable failure. */ }
    return setupResponse({ hasUsers: false, hasAdmin: false, hasSuperAdmin: false, readiness, workersReady: false, setupStep: readiness.ready ? "account" : "requirements", setupRequired: true, error: message })
  }
}
