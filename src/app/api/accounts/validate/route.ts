import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/server-auth"

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const body = await request.json()
    const { apiToken } = body as {
      apiToken?: string
    }

    if (!apiToken) {
      return NextResponse.json(
        { error: "API token is required" },
        { status: 400 }
      )
    }

    const res = await fetch(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
      }
    )

    const data = await res.json().catch(() => null)

    if (!res.ok || !data?.success) {
      const message =
        data?.errors?.[0]?.message ??
        data?.messages?.[0]?.message ??
        "Token is not valid for the Cloudflare API"
      return NextResponse.json(
        { validToken: false, error: message },
        { status: 200 }
      )
    }

    const result = data.result ?? {}
    const policies: any[] = Array.isArray(result.policies)
      ? result.policies
      : []

    const accountIds = new Set<string>()
    for (const policy of policies) {
      const resources = policy?.resources ?? {}
      for (const key of Object.keys(resources)) {
        const prefix = "com.cloudflare.api.account."
        if (key.startsWith(prefix)) {
          const id = key.slice(prefix.length)
          if (id && id !== "*") {
            accountIds.add(id)
          }
        }
      }
    }

    return NextResponse.json({
      validToken: true,
      accountIds: Array.from(accountIds),
      tokenId: result.id ?? null,
    })
  } catch (error: any) {
    const message = error?.message ?? "Unable to validate token"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

