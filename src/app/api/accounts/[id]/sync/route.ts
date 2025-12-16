import { NextResponse } from "next/server"
import { getAllAccounts, updateAccount } from "@/lib/accounts-store"

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params

    const account = (await getAllAccounts()).find((a) => a.id === id)
    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 })
    }

    const started = new Date().toISOString()
    await updateAccount(id, {
      syncStatus: "syncing",
      syncMessage: "Sync in progress",
      lastSyncedAt: started,
    })

    const cfRes = await fetch("https://api.cloudflare.com/client/v4/accounts", {
      headers: {
        Authorization: `Bearer ${account.apiToken}`,
      },
    })

    if (!cfRes.ok) {
      const errorBody = await cfRes.text().catch(() => "")
      const finishedError = await updateAccount(id, {
        syncStatus: "error",
        syncMessage: "Unable to fetch Cloudflare account information",
      })
      return NextResponse.json(
        {
          error: "Unable to fetch Cloudflare account information",
          details: errorBody,
          account: finishedError,
        },
        { status: 400 }
      )
    }

    const body = await cfRes.json()
    const result = body?.result

    // For tokens bound to a single account, result may be an object, not an array.
    const firstAccount =
      Array.isArray(result) && result.length > 0 ? result[0] : result

    if (!firstAccount || !firstAccount.id) {
      const finishedError = await updateAccount(id, {
        syncStatus: "error",
        syncMessage: "No Cloudflare account found for this token",
      })
      return NextResponse.json(
        {
          error: "No Cloudflare account found for this token",
          account: finishedError,
        },
        { status: 400 }
      )
    }

    let totalBuckets: number | undefined = undefined
    let totalObjects: number | undefined = undefined
    let totalBytes: number | undefined = undefined

    try {
      const bucketsRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${firstAccount.id}/r2/buckets`,
        {
          headers: {
            Authorization: `Bearer ${account.apiToken}`,
          },
        }
      )

      if (bucketsRes.ok) {
        const bucketsBody = await bucketsRes.json()
        const bucketsResult = bucketsBody?.result
        const bucketsArray = Array.isArray(bucketsResult?.buckets)
          ? bucketsResult.buckets
          : Array.isArray(bucketsResult)
          ? bucketsResult
          : []

        totalBuckets = bucketsArray.length
        totalObjects = bucketsArray.reduce((sum: number, bucket: any) => {
          const objects =
            typeof bucket?.objects === "number"
              ? bucket.objects
              : typeof bucket?.object_count === "number"
              ? bucket.object_count
              : 0
          return sum + objects
        }, 0)
        totalBytes = bucketsArray.reduce((sum: number, bucket: any) => {
          const size =
            typeof bucket?.size === "number"
              ? bucket.size
              : typeof bucket?.size_bytes === "number"
              ? bucket.size_bytes
              : 0
          return sum + size
        }, 0)
      }
    } catch {
      // Ignore bucket errors; we'll still save account id and mark sync ok.
    }

    const finished = await updateAccount(id, {
      cloudflareAccountId: firstAccount.id,
      cloudflareAccountName: firstAccount.name ?? undefined,
      totalBuckets: totalBuckets ?? account.totalBuckets ?? 0,
      totalObjects: totalObjects ?? account.totalObjects ?? 0,
      totalBytes: totalBytes ?? account.totalBytes ?? 0,
      syncStatus: "ok",
      syncMessage: "Last sync completed",
      lastSyncedAt: new Date().toISOString(),
    })

    return NextResponse.json({ account: finished })
  } catch (error: any) {
    const message = error?.message ?? "Unable to sync account"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
