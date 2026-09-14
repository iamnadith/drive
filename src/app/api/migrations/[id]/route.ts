import { NextResponse } from "next/server"
import { deleteMigration, getMigration, listMigrationItems } from "@/lib/migrations-store"
import { requireAdmin } from "@/lib/server-auth"
import { getMigrationReadOnlyState } from "@/lib/migration-read-only"
import { listMigrationWorkerRuns } from "@/lib/migration-worker-runs"
import { listDashboardAccountSummaries } from "@/lib/accounts-store"

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const migration = await getMigration(id)
    if (!migration) {
      return NextResponse.json({ error: "Migration not found" }, { status: 404 })
    }
    // Read the persisted migration projection. Synchronization is owned by the
    // orchestrator and must not delay every page/detail read.
    const readOnly = getMigrationReadOnlyState(migration)
    const [items, workerRuns, accountSummaries] = await Promise.all([
      listMigrationItems(id),
      migration.options.executionMode === "migration_workers" ? listMigrationWorkerRuns(id).catch(() => []) : Promise.resolve([]),
      listDashboardAccountSummaries().catch(() => []),
    ])
    const accounts = accountSummaries.map(({ id: accountId, label, email, status }) => ({ id: accountId, label, email, status }))
    return NextResponse.json({ migration, items, workerRuns, accounts, historyReadOnly: readOnly }, { status: 200 })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unable to load migration")
        : "Unable to load migration"
    return NextResponse.json(
      { error: message },
      { status: 400 }
    )
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const migration = await getMigration(id)
    if (!migration) {
      return NextResponse.json({ error: "Migration not found" }, { status: 404 })
    }
    await deleteMigration(id)
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "Unable to delete migration")
        : "Unable to delete migration"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
