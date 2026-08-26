function createStorageObjectMetadataHeaders(contentLength) {
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) return {}
  const size = String(contentLength)
  return {
    "Content-Length": size,
    "X-Drive-Object-Size": size,
  }
}

module.exports = { createStorageObjectMetadataHeaders }
