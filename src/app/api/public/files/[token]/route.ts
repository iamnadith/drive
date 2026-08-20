import { NextResponse } from "next/server"
import { getActiveProjectBucketR2Config } from "@/lib/project-api-auth"
import { getProjectObjectInventoryByFileId } from "@/lib/project-operations-store"
import { getProjectFileLinkByToken } from "@/lib/projects-store"
import { r2CreateSignedDownloadUrl } from "@/lib/r2-s3"
import { rejectDisallowedBucketDeliveryOrigin } from "@/lib/bucket-delivery-origin-guard"

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params
  const resolved = await getProjectFileLinkByToken(token)
  if (!resolved) return NextResponse.json({ error: "Link not found" }, { status: 404 })

  const currentObject = resolved.link.fileId
    ? await getProjectObjectInventoryByFileId(resolved.project.id, resolved.link.fileId)
    : null
  const objectKey = currentObject?.key ?? resolved.link.objectKey
  const bucketName = currentObject?.bucketName ?? resolved.link.bucketName ?? resolved.project.bucketName
  if (!objectKey) return NextResponse.json({ error: "Link target not found" }, { status: 404 })

  const r2 = await getActiveProjectBucketR2Config(
    resolved.project,
    bucketName
  )
  if ("response" in r2) return r2.response
  const originRejection = await rejectDisallowedBucketDeliveryOrigin(request, r2.bucketName)
  if (originRejection) return originRejection

  const url = new URL(request.url)
  const signedUrl = await r2CreateSignedDownloadUrl(
    r2.config,
    r2.bucketName,
    objectKey,
    {
      expiresInSeconds: 300,
      ...(url.searchParams.get("download") === "1"
        ? { filename: objectKey.split("/").pop() ?? objectKey }
        : {}),
    }
  )
  return NextResponse.redirect(signedUrl, 302)
}
