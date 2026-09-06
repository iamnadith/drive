import { NextResponse } from "next/server"
import { getAllAccounts } from "@/lib/accounts-store"
import { getBucketDeliverySettings } from "@/lib/bucket-delivery-settings-store"
import { getEffectiveBucketMediaOrigins } from "@/lib/bucket-delivery-settings-service"
import { authorizeProjectRequest, projectIdFromUrl } from "@/lib/project-api-auth"
import { listProjectsUsingBucket } from "@/lib/projects-store"
import { r2CreateSignedDownloadUrl, r2CreateSignedHeadUrl } from "@/lib/r2-s3"
import {
  createStorageDeliveryHeaders,
  createStorageDeliveryOptionsResponse,
  createStorageDeliveryRedirect,
  isStorageDeliveryOriginAllowed,
  isSystemDerivativeKey,
  STORAGE_DERIVATIVE_OBJECT_CACHE_CONTROL,
  STORAGE_DERIVATIVE_REDIRECT_CACHE_CONTROL,
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
  const configuredOrigins = (await getEffectiveBucketMediaOrigins(active.id, bucket, settings)).effectiveMediaAllowedOrigins.join(",")
  const origin = request.headers.get("origin")
  if (!isStorageDeliveryOriginAllowed(origin, configuredOrigins)) {
    const response = NextResponse.json(
      { error: "Request origin is not allowed for this bucket" },
      { status: 403 }
    )
    createStorageDeliveryHeaders(origin, configuredOrigins).forEach((value, name) => {
      response.headers.set(name, value)
    })
    return response
  }
  if (!settings.publicAccessEnabled) {
    const assignedProjects = await listProjectsUsingBucket(active.id, bucket)
    if (assignedProjects.length === 0) {
      const response = NextResponse.json(
        { error: "Private bucket delivery requires an assigned project" },
        { status: 403 }
      )
      createStorageDeliveryHeaders(request.headers.get("origin"), configuredOrigins).forEach(
        (value, name) => response.headers.set(name, value)
      )
      return response
    }
    const requestedProjectId = projectIdFromUrl(request)
    const requestedProject = requestedProjectId
      ? assignedProjects.find((project) => project.id === requestedProjectId || project.projectId === requestedProjectId)
      : null
    if (requestedProjectId && !requestedProject) {
      const response = NextResponse.json({ error: "Requested project is not assigned to this bucket" }, { status: 403 })
      createStorageDeliveryHeaders(request.headers.get("origin"), configuredOrigins).forEach(
        (value, name) => response.headers.set(name, value)
      )
      return response
    }
    const candidates = requestedProject ? [requestedProject] : assignedProjects
    let authResponse: NextResponse | undefined
    let authorized = false
    for (const candidate of candidates) {
      const result = await authorizeProjectRequest(request, candidate.projectId, "read")
      if (!("response" in result)) {
        authorized = true
        break
      }
      authResponse = result.response
    }
    if (!authorized) {
      const response = authResponse ?? NextResponse.json({ error: "Project authorization failed" }, { status: 401 })
      createStorageDeliveryHeaders(request.headers.get("origin"), configuredOrigins).forEach(
        (value, name) => response.headers.set(name, value)
      )
      return response
    }
  }
  const url = new URL(request.url)
  const download = url.searchParams.get("download") === "1"
  const cacheDerivative = !download && isSystemDerivativeKey(objectKey)
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
          ...(cacheDerivative ? {
            cacheControl: STORAGE_DERIVATIVE_OBJECT_CACHE_CONTROL,
          } : {}),
        })

  return createStorageDeliveryRedirect(
    signedUrl,
    request.headers.get("origin"),
    configuredOrigins,
    cacheDerivative ? STORAGE_DERIVATIVE_REDIRECT_CACHE_CONTROL : undefined
  )
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
  const configuredOrigins = settings
    ? (await getEffectiveBucketMediaOrigins(active!.id, bucket, settings)).effectiveMediaAllowedOrigins.join(",")
    : undefined
  if (!isStorageDeliveryOriginAllowed(request.headers.get("origin"), configuredOrigins)) {
    return NextResponse.json({ error: "Request origin is not allowed for this bucket" }, { status: 403 })
  }
  return createStorageDeliveryOptionsResponse(
    request.headers.get("origin"),
    configuredOrigins
  )
}
