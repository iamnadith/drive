import { NextResponse } from "next/server"
import { deleteMigration, getMigration, listMigrationItems } from "@/lib/migrations-store"
import { syncMigrationLiveState } from "@/lib/migration-live-state"
import { listRepairJobsByMigration } from "@/lib/repair-jobs-store"
import { requireAdmin } from "@/lib/server-auth"
import { getMigrationReadOnlyState } from "@/lib/migration-read-only"
import { listMigrationWorkerRuns } from "@/lib/migration-worker-runs"

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    let migration = await getMigration(id)
    if (!migration) {
      return NextResponse.json({ error: "Migration not found" }, { status: 404 })
    }
    const initialReadOnly = getMigrationReadOnlyState(migration)
    // Migration Orchestrator owns worker-pool projection. Keep this page load
    // bounded instead of scanning thousands of internal file records.
    if (!initialReadOnly.readOnly && migration.options.executionMode !== "migration_workers") {
      await syncMigrationLiveState(id).catch(() => undefined)
      migration = await getMigration(id) ?? migration
    }
    const readOnly = getMigrationReadOnlyState(migration)
    const [items, repairJobs, workerRuns] = await Promise.all([
      listMigrationItems(id),
      migration.options.executionMode === "migration_workers" ? Promise.resolve([]) : listRepairJobsByMigration(id, 20).catch(() => []),
      migration.options.executionMode === "migration_workers" ? listMigrationWorkerRuns(id).catch(() => []) : Promise.resolve([]),
    ])
    return NextResponse.json({ migration, items, repairJobs: repairJobs.filter((job) => job.mode !== "migration"), workerRuns, historyReadOnly: readOnly }, { status: 200 })
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
