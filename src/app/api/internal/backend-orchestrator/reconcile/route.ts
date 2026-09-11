import { after, NextResponse } from "next/server"
import { authenticateBackendOrchestrator } from "@/lib/backend-orchestrator-auth"
import { runDatabaseMaintenance } from "@/lib/database-maintenance"
import { listMigrations } from "@/lib/migrations-store"
import { syncMigrationLiveState } from "@/lib/migration-live-state"
import { reconcileRepairJobs } from "@/lib/repair-jobs-store"
import { getAllAccounts } from "@/lib/accounts-store"
import { reconcileAssignedProjectDeliveryCors } from "@/lib/bucket-delivery-settings-service"
import { reconcileAndRepairCloudflareWorkers } from "@/lib/cloudflare-worker-installer"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: Request) {
  const auth = await authenticateBackendOrchestrator(request)
  if (!auth.ok) return NextResponse.json({ error: "Invalid Backend Orchestrator secret" }, { status: 401 })
  if (!auth.settings.enabled) return NextResponse.json({ error: "Backend Orchestrator is disabled" }, { status: 403 })
  after(async () => { await reconcileAndRepairCloudflareWorkers(false).catch((error) => console.error("Cloudflare Worker self-healing failed", error)) })

  const migrations = (await listMigrations(100))
    .filter((migration) => ["running", "verifying"].includes(migration.status) || migration.syncStatus === "syncing")
    .slice(0, 5)
  const results = []
  for (const migration of migrations) {
    try {
      await syncMigrationLiveState(migration.id)
      results.push({ id: migration.id, ok: true })
    } catch (error) {
      results.push({ id: migration.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  await reconcileRepairJobs().catch(() => undefined)
  const accounts = await getAllAccounts().catch(() => [])
  const deliveryByAccount = await Promise.all(accounts.map(async (account) => ({
    accountId: account.id,
    accountLabel: account.label,
    result: await reconcileAssignedProjectDeliveryCors({ account, limit: 2 }).catch((error) => ({
      checked: 0,
      changed: 0,
      unchanged: 0,
      errors: [{ bucketName: "reconciliation", ok: false, error: error instanceof Error ? error.message : String(error) }],
    })),
  })))
  const delivery = {
    checked: deliveryByAccount.reduce((sum, entry) => sum + entry.result.checked, 0),
    changed: deliveryByAccount.reduce((sum, entry) => sum + entry.result.changed, 0),
    unchanged: deliveryByAccount.reduce((sum, entry) => sum + entry.result.unchanged, 0),
    errors: deliveryByAccount.flatMap((entry) => entry.result.errors.map((error) => ({
      accountId: entry.accountId,
      accountLabel: entry.accountLabel,
      ...error,
    }))),
    accounts: deliveryByAccount,
  }
  const maintenance = await runDatabaseMaintenance().catch(() => ({ ran: false, deleted: {}, compactedMigrations: 0 }))
  return NextResponse.json({ ok: delivery.errors.length === 0, migrations: results, delivery, maintenance })
}
