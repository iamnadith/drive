import { NextResponse } from "next/server"
import {
  CloudflareAccount,
  createAccount,
  getAllAccounts,
  getActiveAccount,
  updateAccount,
} from "@/lib/accounts-store"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"
import { requireAdmin } from "@/lib/server-auth"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    let accounts = await getAllAccounts()

    if (accounts.length > 0) {
      const active = await getActiveAccount()
      if (!active) {
        const fallback = accounts.find((account) => account.status === "available")
        if (fallback) {
          // Promote the first available account to active if none exists.
          await updateAccount(fallback.id, { status: "active" })
          accounts = await getAllAccounts()
        }
      }
    }

    return NextResponse.json({ accounts })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to load accounts")
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const body = await request.json()
    const actorUserId = auth.user.id
    const beforeAccounts = await getAllAccounts()
    const {
      label,
      email,
      password,
      twoFactorSecret,
      apiToken,
      r2AccessKeyId,
      r2SecretAccessKey,
      makeActive,
    } = body as {
      label?: string
      email?: string
      password?: string
      twoFactorSecret?: string
      apiToken?: string
      r2AccessKeyId?: string
      r2SecretAccessKey?: string
      makeActive?: boolean
    }

    if (
      !label ||
      !email ||
      !password ||
      !twoFactorSecret ||
      !apiToken ||
      !r2AccessKeyId ||
      !r2SecretAccessKey
    ) {
      return NextResponse.json(
        {
          error:
            "Label, email, password, 2FA secret, API token and R2 access keys are required",
        },
        { status: 400 }
      )
    }

    const account: CloudflareAccount = await createAccount({
      label,
      email,
      password,
      twoFactorSecret,
      apiToken,
      r2AccessKeyId: r2AccessKeyId!,
      r2SecretAccessKey: r2SecretAccessKey!,
      makeActive,
    })
    const afterAccounts = await getAllAccounts()
    const changedActiveAccount = beforeAccounts.some((before) => {
      const after = afterAccounts.find((candidate) => candidate.id === before.id)
      return after && before.status !== after.status
    }) || account.status === "active"

    await recordActivity({
      actorUserId,
      action: "account.created",
      entityType: "account",
      entityId: account.id,
      entityLabel: account.label,
      summary: `Created account ${account.label}`,
      detail: account.status === "active" ? "The new account became active." : "The new account was added as available.",
      before: {
        accounts: beforeAccounts.map((item) => ({
          id: item.id,
          label: item.label,
          status: item.status,
          lastMigrated: item.lastMigrated,
        })),
      },
      after: {
        account,
        accounts: afterAccounts.map((item) => ({
          id: item.id,
          label: item.label,
          status: item.status,
          lastMigrated: item.lastMigrated,
        })),
      },
      undoable: changedActiveAccount && beforeAccounts.length > 0,
      undoReason: beforeAccounts.length === 0 ? "Initial account creation cannot be undone automatically." : null,
      undoPayload:
        changedActiveAccount && beforeAccounts.length > 0
          ? {
              type: "restore_account_statuses",
              accounts: beforeAccounts.map((item) => ({
                id: item.id,
                status: item.status,
                lastMigrated: item.lastMigrated,
              })),
            }
          : null,
      ...getRequestActivityContext(request),
    })

    return NextResponse.json({ account })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to create account")
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
