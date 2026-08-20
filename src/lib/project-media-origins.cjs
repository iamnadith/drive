const MAX_MEDIA_ALLOWED_ORIGINS = 20
const MAX_ORIGIN_LENGTH = 2048

function isLocalDevelopmentHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
}

function normalizeMediaAllowedOrigin(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Each media allowed origin must be a non-empty URL origin")
  }
  if (value.trim().length > MAX_ORIGIN_LENGTH) {
    throw new Error(`Media allowed origins must be at most ${MAX_ORIGIN_LENGTH} characters`)
  }
  if (value.trim() === "*") return "*"

  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error("Each media allowed origin must be a valid URL origin")
  }

  const isHttps = url.protocol === "https:"
  const isLocalHttp = url.protocol === "http:" && isLocalDevelopmentHost(url.hostname)
  if (!isHttps && !isLocalHttp) {
    throw new Error("Media allowed origins must use HTTPS, except localhost development origins")
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Media allowed origins must not include credentials, paths, queries, or fragments")
  }
  if (!url.origin || url.origin === "null") {
    throw new Error("Each media allowed origin must be a valid URL origin")
  }
  return url.origin
}

function normalizeMediaAllowedOrigins(value) {
  if (!Array.isArray(value)) {
    throw new Error("mediaAllowedOrigins must be an array of URL origins")
  }
  if (value.length > MAX_MEDIA_ALLOWED_ORIGINS) {
    throw new Error(`A delivery policy can have at most ${MAX_MEDIA_ALLOWED_ORIGINS} media allowed origins`)
  }
  const normalized = [...new Set(value.map(normalizeMediaAllowedOrigin))]
  return normalized.includes("*") ? ["*"] : normalized
}

function mergeMediaAllowedOrigins(inherited, manual) {
  const combined = [
    ...(Array.isArray(inherited) ? inherited : []),
    ...(Array.isArray(manual) ? manual : []),
  ]
  if (combined.includes("*")) return ["*"]
  return [...new Set(combined.filter((origin) => typeof origin === "string"))]
}

function hasProjectBucketDeliveryPolicyMutation(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (Object.prototype.hasOwnProperty.call(value, "mediaAllowedOrigins") ||
        Object.prototype.hasOwnProperty.call(value, "deliveryPublicAccessEnabled"))
  )
}

module.exports = {
  MAX_MEDIA_ALLOWED_ORIGINS,
  normalizeMediaAllowedOrigin,
  normalizeMediaAllowedOrigins,
  mergeMediaAllowedOrigins,
  hasProjectBucketDeliveryPolicyMutation,
}
