import { NextResponse } from "next/server"
import { deleteAccount, updateAccount } from "@/lib/accounts-store"

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
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

    return NextResponse.json({ account: updated })
  } catch (error: any) {
    const message = error?.message ?? "Unable to update account"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    await deleteAccount(id)
    return NextResponse.json({ success: true })
  } catch (error: any) {
    const message = error?.message ?? "Unable to delete account"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
