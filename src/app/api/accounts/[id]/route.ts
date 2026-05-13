import { NextResponse } from "next/server"
import { deleteAccount, getAllAccounts, updateAccount } from "@/lib/accounts-store"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const actorUserId = auth.user.id
    const beforeAccounts = await getAllAccounts()
    const before = beforeAccounts.find((account) => account.id === id)
    const body = await request.json()

    const {
      status,
      label,
      email,
      password,
      twoFactorSecret,
      apiToken,
      cloudflareAccountId,
    } = body as {
      status?: "active" | "disabled" | "available"
      label?: string
      email?: string
      password?: string
      twoFactorSecret?: string
      apiToken?: string
      cloudflareAccountId?: string
    }

    const updates: Record<string, unknown> = {}
    if (typeof status !== "undefined") updates.status = status
    if (typeof label !== "undefined") updates.label = label
    if (typeof email !== "undefined") updates.email = email
    if (typeof password !== "undefined") updates.password = password
    if (typeof twoFactorSecret !== "undefined")
      updates.twoFactorSecret = twoFactorSecret
    if (typeof apiToken !== "undefined") updates.apiToken = apiToken
    if (typeof cloudflareAccountId !== "undefined")
      updates.cloudflareAccountId = cloudflareAccountId

    const updated = await updateAccount(id, updates)
    const afterAccounts = await getAllAccounts()
    const changedStatus = typeof status !== "undefined" && before?.status !== updated.status
    const changedActiveAccount = changedStatus || beforeAccounts.some((account) => {
      const after = afterAccounts.find((candidate) => candidate.id === account.id)
      return after && account.status !== after.status
    })

    await recordActivity({
      actorUserId,
      action: changedActiveAccount ? "account.active_status_changed" : "account.updated",
      entityType: "account",
      entityId: id,
      entityLabel: updated.label,
      summary: changedActiveAccount
        ? `Changed active account status for ${updated.label}`
        : `Updated account ${updated.label}`,
      detail: changedActiveAccount
        ? "Account status changes are permanent. Disabled accounts cannot be restored."
        : "Account credentials or profile fields were updated.",
      before: {
        account: before,
        accounts: beforeAccounts.map((account) => ({
          id: account.id,
          label: account.label,
          status: account.status,
          lastMigrated: account.lastMigrated,
        })),
      },
      after: {
        account: updated,
        accounts: afterAccounts.map((account) => ({
          id: account.id,
          label: account.label,
          status: account.status,
          lastMigrated: account.lastMigrated,
        })),
      },
      undoable: false,
      undoReason: changedActiveAccount
        ? "Account status changes are permanent. Disabled accounts cannot be restored."
        : "Only account profile fields were changed.",
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ account: updated })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to update account")
    return NextResponse.json({ error: message }, { status: 400 })
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
    const actorUserId = auth.user.id
    const before = (await getAllAccounts()).find((account) => account.id === id)
    await deleteAccount(id)
    await recordActivity({
      actorUserId,
      action: "account.deleted",
      entityType: "account",
      entityId: id,
      entityLabel: before?.label,
      summary: `Deleted account ${before?.label ?? id}`,
      detail: "Account deletion is not automatically undoable because credentials and external state may no longer be valid.",
      before: before ? { account: before } : null,
      undoReason: "Deleted accounts must be recreated manually.",
      ...getRequestActivityContext(_request),
    })
    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to delete account")
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
