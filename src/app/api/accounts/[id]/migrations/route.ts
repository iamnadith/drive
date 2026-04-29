import { NextResponse } from "next/server"
import { deleteMigration, listMigrationsByAccount } from "@/lib/migrations-store"
import { requireAdmin } from "@/lib/server-auth"

function toMessage(error: unknown, fallback: string): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const migrations = await listMigrationsByAccount(id)
    return NextResponse.json({ migrations }, { status: 200 })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: toMessage(error, "Unable to load account migrations") },
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
    const migrations = await listMigrationsByAccount(id)
    await Promise.all(migrations.map((migration) => deleteMigration(migration.id)))
    return NextResponse.json({ ok: true, deleted: migrations.length }, { status: 200 })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: toMessage(error, "Unable to delete account migrations") },
      { status: 400 }
    )
  }
}
