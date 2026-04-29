import { NextResponse } from "next/server"
import { getAllAccounts, updateAccount } from "@/lib/accounts-store"
import { requireAdmin } from "@/lib/server-auth"

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params

    const account = (await getAllAccounts()).find((a) => a.id === id)
    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 })
    }

    const cfRes = await fetch("https://api.cloudflare.com/client/v4/accounts", {
      headers: {
        Authorization: `Bearer ${account.apiToken}`,
      },
    })

    if (!cfRes.ok) {
      const errorBody = await cfRes.text().catch(() => "")
      return NextResponse.json(
        {
          error: "Unable to fetch Cloudflare account information",
          details: errorBody,
        },
        { status: 400 }
      )
    }

    const body = await cfRes.json()
    const result = body?.result

    const firstAccount =
      Array.isArray(result) && result.length > 0 ? result[0] : result

    if (!firstAccount || !firstAccount.id) {
      return NextResponse.json(
        { error: "No Cloudflare account found for this token" },
        { status: 400 }
      )
    }

    const updated = await updateAccount(id, {
      cloudflareAccountId: firstAccount.id,
    })

    return NextResponse.json({ account: updated })
  } catch (error: any) {
    const message = error?.message ?? "Unable to sync account ID"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
