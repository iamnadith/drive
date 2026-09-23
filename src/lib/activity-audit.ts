import { recordActivity, getRequestActivityContext, type RecordActivityInput } from "@/lib/activity-store"

/** Record a concise audit event for an authenticated dashboard mutation.
 * Call only after the mutation has succeeded; never pass request bodies here.
 */
export async function recordUserActivity(
  request: Request,
  actorUserId: string,
  event: Omit<RecordActivityInput, "actorUserId" | "ipAddress" | "userAgent" | "requestId">,
) {
  await recordActivity({
    ...event,
    actorUserId,
    ...getRequestActivityContext(request),
  })
}
