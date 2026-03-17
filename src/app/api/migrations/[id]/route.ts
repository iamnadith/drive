import { NextResponse } from "next/server"
import { deleteMigration, getMigration, listMigrationItems } from "@/lib/migrations-store"
import { listRepairJobsByMigration } from "@/lib/repair-jobs-store"

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    const migration = await getMigration(id)
    if (!migration) {
      return NextResponse.json({ error: "Migration not found" }, { status: 404 })
    }
    const [items, repairJobs] = await Promise.all([listMigrationItems(id), listRepairJobsByMigration(id, 20)])
    return NextResponse.json({ migration, items, repairJobs }, { status: 200 })
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
