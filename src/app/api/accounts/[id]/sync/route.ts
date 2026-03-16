import { NextResponse } from "next/server"
import { getAllAccounts, updateAccount } from "@/lib/accounts-store"
import { r2ListBuckets } from "@/lib/cloudflare-r2-buckets"
import { ensureBucketStatsRows, getBucketStatsMap } from "@/lib/bucket-stats-store"

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
    let statsMessage: string | undefined = undefined

    try {
      const buckets = await r2ListBuckets({ accountId: firstAccount.id, apiToken: account.apiToken })
      const bucketNames = buckets.map((b) => b.name).filter(Boolean)
      totalBuckets = bucketNames.length

      await ensureBucketStatsRows(account.id, bucketNames)
      const statsMap = await getBucketStatsMap(account.id)

      const completed = bucketNames
        .map((n) => statsMap.get(n))
        .filter((s) => s && s.status === "completed")

      const objectsSum = completed.reduce((sum, s) => sum + (s?.objects ?? 0), 0)
      const bytesSum = completed.reduce((sum, s) => sum + (s?.bytes ?? 0), 0)

      totalObjects = objectsSum
      totalBytes = bytesSum

      const remaining = bucketNames.filter((n) => statsMap.get(n)?.status !== "completed").length
      if (remaining > 0) statsMessage = `Bucket stats pending for ${remaining} bucket(s)`
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
      syncMessage: statsMessage ?? "Last sync completed",
      lastSyncedAt: new Date().toISOString(),
    })

    return NextResponse.json({ account: finished })
  } catch (error: any) {
    const message = error?.message ?? "Unable to sync account"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
