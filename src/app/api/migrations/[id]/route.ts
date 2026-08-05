import { NextResponse } from "next/server"
import { deleteMigration, getMigration, listMigrationItems } from "@/lib/migrations-store"
import { syncMigrationLiveState } from "@/lib/migration-live-state"
import { listRepairJobsByMigration } from "@/lib/repair-jobs-store"
import { requireAdmin } from "@/lib/server-auth"
import { getMigrationReadOnlyState } from "@/lib/migration-read-only"

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
    if (!initialReadOnly.readOnly) {
      await syncMigrationLiveState(id).catch(() => undefined)
      migration = await getMigration(id) ?? migration
    }
    const readOnly = getMigrationReadOnlyState(migration)
    const [items, repairJobs] = await Promise.all([
      listMigrationItems(id),
      listRepairJobsByMigration(id, 20).catch(() => []),
    ])
    return NextResponse.json({ migration, items, repairJobs, historyReadOnly: readOnly }, { status: 200 })
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
