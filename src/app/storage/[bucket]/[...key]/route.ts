import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { getBucketDeliverySettings } from "@/lib/bucket-delivery-settings-store"
import { authorizeProjectRequest } from "@/lib/project-api-auth"
import { listProjectsUsingBucket } from "@/lib/projects-store"
import { r2CreateSignedDownloadUrl, r2CreateSignedHeadUrl } from "@/lib/r2-s3"
import {
  createStorageDeliveryHeaders,
  createStorageDeliveryOptionsResponse,
  createStorageDeliveryRedirect,
} from "@/lib/storage-delivery.cjs"

export const dynamic = "force-dynamic"
export const revalidate = 0

async function redirectToStorageObject(
  request: Request,
  context: { params: Promise<{ bucket: string; key: string[] }> },
  method: "GET" | "HEAD"
) {
  const { bucket, key } = await context.params
  const objectKey = key.join("/")

  if (!bucket || !objectKey) {
    return NextResponse.json({ error: "Missing storage object path" }, { status: 400 })
  }

  const accounts = await getAllAccounts()
  const active = accounts.find((account) => account.status === "active")
  if (!active?.cloudflareAccountId || !active.r2AccessKeyId || !active.r2SecretAccessKey) {
    return NextResponse.json({ error: "Active Cloudflare account is missing R2 credentials" }, { status: 400 })
  }
  const settings = await getBucketDeliverySettings(active.id, bucket)
  const configuredOrigins = settings.mediaAllowedOrigins?.join(",")
  if (!settings.publicAccessEnabled) {
    const assignedProjects = await listProjectsUsingBucket(bucket)
    if (assignedProjects.length !== 1) {
      const response = NextResponse.json(
        { error: "Private bucket delivery requires exactly one assigned project" },
        { status: 403 }
      )
      createStorageDeliveryHeaders(request.headers.get("origin"), configuredOrigins).forEach(
        (value, name) => response.headers.set(name, value)
      )
      return response
    }
    const authorized = await authorizeProjectRequest(request, assignedProjects[0].id, "read")
    const authResponse = "response" in authorized ? authorized.response : undefined
    if (authResponse) {
      createStorageDeliveryHeaders(request.headers.get("origin"), configuredOrigins).forEach(
        (value, name) => authResponse.headers.set(name, value)
      )
      return authResponse
    }
  }
  const url = new URL(request.url)
  const download = url.searchParams.get("download") === "1"
  const config = {
    accountId: active.cloudflareAccountId,
    accessKeyId: active.r2AccessKeyId,
    secretAccessKey: active.r2SecretAccessKey,
  }
  const signedUrl =
    method === "HEAD"
      ? await r2CreateSignedHeadUrl(config, bucket, objectKey, { expiresInSeconds: 900 })
      : await r2CreateSignedDownloadUrl(config, bucket, objectKey, {
          expiresInSeconds: 900,
          ...(download ? { filename: objectKey.split("/").pop() ?? objectKey } : {}),
        })

  return createStorageDeliveryRedirect(signedUrl, request.headers.get("origin"), configuredOrigins)
}

export async function GET(
  request: Request,
  context: { params: Promise<{ bucket: string; key: string[] }> }
) {
  return redirectToStorageObject(request, context, "GET")
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ bucket: string; key: string[] }> }
) {
  return redirectToStorageObject(request, context, "HEAD")
}

export async function OPTIONS(
  request: Request,
  context: { params: Promise<{ bucket: string; key: string[] }> }
) {
  const { bucket } = await context.params
  const accounts = await getAllAccounts()
  const active = accounts.find((account) => account.status === "active")
  const settings = active ? await getBucketDeliverySettings(active.id, bucket) : null
  return createStorageDeliveryOptionsResponse(
    request.headers.get("origin"),
    settings?.mediaAllowedOrigins?.join(",")
  )
}
