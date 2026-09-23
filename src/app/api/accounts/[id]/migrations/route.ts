import { NextResponse } from "next/server"
import { deleteMigration, listMigrationsByAccount } from "@/lib/migrations-store"
import { requireAdmin } from "@/lib/server-auth"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"

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
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const migrations = await listMigrationsByAccount(id)
    const results = await Promise.allSettled(migrations.map((migration) => deleteMigration(migration.id)))
    const deleted = results.filter((result) => result.status === "fulfilled").length
    const failed = results.length - deleted
    if (deleted > 0) {
      await recordActivity({
        actorUserId: auth.user.id,
        action: "migration.account_history_deleted",
        entityType: "account",
        entityId: id,
        summary: `Deleted ${deleted} migration record${deleted === 1 ? "" : "s"} for an account`,
        outcome: failed > 0 ? "warning" : "success",
        metadata: { deleted, failed },
        ...getRequestActivityContext(request),
      })
    }
    if (failed > 0) return NextResponse.json({ error: "Some migration records could not be deleted", deleted, failed }, { status: 500 })
    return NextResponse.json({ ok: true, deleted }, { status: 200 })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: toMessage(error, "Unable to delete account migrations") },
      { status: 400 }
    )
  }
}
