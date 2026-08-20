import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { runBucketDangerAction, type BucketDangerAction } from "@/lib/bucket-danger-actions"
import { recordActivity, getRequestActivityContext } from "@/lib/activity-store"
import { requireAdmin } from "@/lib/server-auth"

export async function POST(request: Request, context: { params: Promise<{ accountId: string; bucket: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response
    const { accountId, bucket } = await context.params
    const account = (await getAllAccounts()).find((candidate) => candidate.id === accountId)
    if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 })
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; confirmation?: unknown; confirmBucketName?: unknown }
    const action = body.action === "delete" ? "delete" : body.action === "clear" ? "clear" : ""
    if (!action) return NextResponse.json({ error: "Action must be clear or delete" }, { status: 400 })
    const result = await runBucketDangerAction({ account, bucketName: decodeURIComponent(bucket), action: action as BucketDangerAction, confirmation: body.confirmation ?? body.confirmBucketName })
    await recordActivity({
      actorUserId: auth.user.id,
      action: action === "delete" ? "bucket.deleted" : "bucket.cleared",
      entityType: "bucket",
      entityId: `${account.id}:${bucket}`,
      entityLabel: bucket,
      summary: action === "delete" ? `Deleted bucket ${bucket}` : `Cleared bucket ${bucket}`,
      metadata: result,
      undoable: false,
      undoReason: "Bucket destruction cannot be undone.",
      ...getRequestActivityContext(request),
    })
    return NextResponse.json({ ok: true, result })
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Bucket danger action failed" }, { status: 400 })
  }
}
