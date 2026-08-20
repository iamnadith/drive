const STORAGE_REDIRECT_CACHE_CONTROL = "private, no-store, max-age=0"
const STORAGE_CORS_ENV = "DRIVE_MEDIA_ALLOWED_ORIGINS"
const SYSTEM_DERIVATIVE_KEY_REGEX = /(?:-(?:poster|preview|stream|subtitles(?:\.[a-z0-9_-]+)?)\.[a-z0-9]{1,8}|-hls(?:-(?:high|720p))?(?:\.m3u8|-init\.mp4|-[0-9]{5}\.m4s))$/i

function isSystemDerivativeKey(key) {
  return typeof key === "string" && SYSTEM_DERIVATIVE_KEY_REGEX.test(key)
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null
  if (value.trim() === "*") return "*"
  try {
    const origin = new URL(value.trim()).origin
    return origin === "null" ? null : origin
  } catch {
    return null
  }
}

function allowedStorageCorsOrigins(value = process.env[STORAGE_CORS_ENV]) {
  if (typeof value !== "string") return []
  const origins = [...new Set(value.split(",").map(normalizeOrigin).filter(Boolean))]
  return origins.includes("*") ? ["*"] : origins
}

function isStorageDeliveryOriginAllowed(origin, configuredOrigins) {
  if (origin === null || origin === undefined || origin.trim() === "") return true
  const normalizedOrigin = normalizeOrigin(origin)
  if (!normalizedOrigin) return false
  const allowedOrigins = allowedStorageCorsOrigins(configuredOrigins)
  return allowedOrigins.includes("*") || allowedOrigins.includes(normalizedOrigin)
}

function createStorageDeliveryHeaders(origin, configuredOrigins) {
  const headers = new Headers({
    "Cache-Control": STORAGE_REDIRECT_CACHE_CONTROL,
    "CDN-Cache-Control": "no-store",
    "Surrogate-Control": "no-store",
    "Cross-Origin-Resource-Policy": "cross-origin",
    Vary: "Origin",
  })

  const normalizedOrigin = normalizeOrigin(origin)
  const allowedOrigins = allowedStorageCorsOrigins(configuredOrigins)
  if (!normalizedOrigin || (!allowedOrigins.includes("*") && !allowedOrigins.includes(normalizedOrigin))) return headers

  headers.set("Access-Control-Allow-Origin", allowedOrigins.includes("*") ? "*" : normalizedOrigin)
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
  headers.set(
    "Access-Control-Allow-Headers",
    "Range, If-None-Match, If-Modified-Since, Content-Type, Authorization, X-Drive-API-Key, X-Drive-Project, X-Drive-Bucket"
  )
  headers.set(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified"
  )
  headers.set("Access-Control-Max-Age", "86400")
  return headers
}

function createStorageDeliveryRedirect(location, origin, configuredOrigins) {
  const headers = createStorageDeliveryHeaders(origin, configuredOrigins)
  headers.set("Location", location)
  return new Response(null, { status: 302, headers })
}

function createStorageDeliveryOptionsResponse(origin, configuredOrigins) {
  return new Response(null, {
    status: 204,
    headers: createStorageDeliveryHeaders(origin, configuredOrigins),
  })
}

module.exports = {
  STORAGE_CORS_ENV,
  STORAGE_REDIRECT_CACHE_CONTROL,
  isSystemDerivativeKey,
  isStorageDeliveryOriginAllowed,
  allowedStorageCorsOrigins,
  createStorageDeliveryHeaders,
  createStorageDeliveryOptionsResponse,
  createStorageDeliveryRedirect,
}
