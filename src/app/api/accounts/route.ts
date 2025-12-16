import { NextResponse } from "next/server"
import {
  CloudflareAccount,
  createAccount,
  getAllAccounts,
  getActiveAccount,
  updateAccount,
} from "@/lib/accounts-store"

export async function GET() {
  try {
    let accounts = await getAllAccounts()

    if (accounts.length > 0) {
      const active = await getActiveAccount()
      if (!active) {
        // Promote the first account to active if none exists.
        await updateAccount(accounts[0].id, { status: "active" })
        accounts = await getAllAccounts()
      }
    }

    return NextResponse.json({ accounts })
  } catch (error: any) {
    const message = error?.message ?? "Unable to load accounts"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
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

    return NextResponse.json({ account })
  } catch (error: any) {
    const message = error?.message ?? "Unable to create account"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
