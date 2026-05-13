import { getPublicOrigin } from "@/lib/public-origin"

export function encodeStorageKeyPath(key: string) {
  return key
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

export function buildProjectStorageObjectUrl(request: Request, bucketName: string, key: string) {
  const origin = getPublicOrigin(request)
  return `${origin}/storage/${encodeURIComponent(bucketName)}/${encodeStorageKeyPath(key)}`
}
