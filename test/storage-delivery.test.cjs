/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict")
const test = require("node:test")

const {
  STORAGE_REDIRECT_CACHE_CONTROL,
  STORAGE_DERIVATIVE_REDIRECT_CACHE_CONTROL,
  allowedStorageCorsOrigins,
  createStorageDeliveryOptionsResponse,
  createStorageDeliveryRedirect,
  isStorageDeliveryOriginAllowed,
  createStorageDeliveryHeaders,
  isSystemDerivativeKey,
} = require("../src/lib/storage-delivery.cjs")

test("configured origins gate delivery even when another credential is valid", () => {
  assert.equal(isStorageDeliveryOriginAllowed("https://panel.example.com", "https://panel.example.com"), true)
  assert.equal(isStorageDeliveryOriginAllowed("https://evil.example.com", "https://panel.example.com"), false)
  assert.equal(isStorageDeliveryOriginAllowed("https://anything.example.com", "*"), true)
  assert.equal(isStorageDeliveryOriginAllowed(null, "https://panel.example.com"), true)
  assert.equal(isStorageDeliveryOriginAllowed("null", "https://panel.example.com"), false)
})

test("only canonical processor derivatives bypass original-object locks", () => {
  for (const key of [
    "movie-hls.m3u8",
    "movie-hls-high.m3u8",
    "movie-hls-high-init.mp4",
    "movie-hls-high-00001.m4s",
    "movie-hls-720p.m3u8",
    "movie-hls-720p-init.mp4",
    "movie-hls-720p-00001.m4s",
  ]) assert.equal(isSystemDerivativeKey(key), true, key)
  assert.equal(isSystemDerivativeKey("movie-hls-untrusted-init.mp4"), false)
  assert.equal(isSystemDerivativeKey("movie-hls-high.mp4"), false)
  assert.equal(isSystemDerivativeKey("folder/movie.mp4"), false)
})

test("normalizes and de-duplicates configured media origins", () => {
  assert.deepEqual(
    allowedStorageCorsOrigins(" https://panel.example.com/, invalid,https://panel.example.com,https://admin.example.com/path "),
    ["https://panel.example.com", "https://admin.example.com"]
  )
})

test("wildcard configuration allows any origin without changing authorization", () => {
  assert.deepEqual(allowedStorageCorsOrigins("https://panel.example.com, *"), ["*"])
  const headers = createStorageDeliveryHeaders("https://random.example", "*")
  assert.equal(headers.get("Access-Control-Allow-Origin"), "*")
  assert.match(headers.get("Access-Control-Allow-Headers") ?? "", /Authorization/)
})

test("delivery redirects are never cacheable", () => {
  const headers = createStorageDeliveryHeaders(undefined, "https://panel.example.com")
  assert.equal(headers.get("Cache-Control"), STORAGE_REDIRECT_CACHE_CONTROL)
  assert.equal(headers.get("CDN-Cache-Control"), "no-store")
  assert.equal(headers.get("Surrogate-Control"), "no-store")
  assert.equal(headers.get("Cross-Origin-Resource-Policy"), "cross-origin")
})

test("CORS is granted only to configured media origins with range response headers exposed", () => {
  const headers = createStorageDeliveryHeaders(
    "https://panel.example.com",
    "https://panel.example.com,https://staging.panel.example.com"
  )
  assert.equal(headers.get("Access-Control-Allow-Origin"), "https://panel.example.com")
  assert.equal(headers.get("Access-Control-Allow-Methods"), "GET, HEAD, OPTIONS")
  assert.match(headers.get("Access-Control-Allow-Headers") ?? "", /Range/)
  assert.match(headers.get("Access-Control-Expose-Headers") ?? "", /Content-Range/)
})

test("unconfigured origins do not gain browser read access", () => {
  const headers = createStorageDeliveryHeaders(
    "https://untrusted.example.com",
    "https://panel.example.com"
  )
  assert.equal(headers.get("Access-Control-Allow-Origin"), null)
})

test("OPTIONS returns an empty CORS preflight response only for configured origins", async () => {
  const allowed = createStorageDeliveryOptionsResponse(
    "https://panel.example.com",
    "https://panel.example.com"
  )
  assert.equal(allowed.status, 204)
  assert.equal(await allowed.text(), "")
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://panel.example.com")

  const missing = createStorageDeliveryOptionsResponse(undefined, "https://panel.example.com")
  assert.equal(missing.status, 204)
  assert.equal(missing.headers.get("Access-Control-Allow-Origin"), null)
})

test("GET and HEAD use the same non-cacheable redirect envelope", () => {
  const redirect = createStorageDeliveryRedirect(
    "https://example.r2.cloudflarestorage.com/media/video.m4s?X-Amz-Signature=redacted",
    "https://panel.example.com",
    "https://panel.example.com"
  )
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get("Location")?.startsWith("https://example.r2.cloudflarestorage.com/"), true)
  assert.equal(redirect.headers.get("Cache-Control"), STORAGE_REDIRECT_CACHE_CONTROL)
})

test("canonical derivatives can use a private redirect cache within signed URL lifetime", () => {
  const redirect = createStorageDeliveryRedirect(
    "https://example.r2.cloudflarestorage.com/media/video-poster.jpg?X-Amz-Signature=redacted",
    "https://panel.example.com",
    "https://panel.example.com",
    STORAGE_DERIVATIVE_REDIRECT_CACHE_CONTROL
  )
  assert.equal(
    redirect.headers.get("Cache-Control"),
    "private, max-age=840, stale-while-revalidate=30"
  )
  assert.equal(redirect.headers.get("CDN-Cache-Control"), "no-store")
})
