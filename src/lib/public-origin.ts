function firstHeaderValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)
  if (!value) return undefined
  return value.split(",")[0]?.trim() || undefined
}

function stripWrappingQuotes(input: string): string {
  const trimmed = input.trim()
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function ensureUrlLike(input: string): string {
  const value = stripWrappingQuotes(input)
  if (!value) return value
  if (value.startsWith("http://") || value.startsWith("https://")) return value
  if (value.startsWith("//")) return `https:${value}`
  // Allow common inputs like "drive.example.com" or "localhost:3000"
  if (/^[a-z0-9.-]+(?::\d+)?$/i.test(value)) return `https://${value}`
  return value
}

function normalizeOrigin(input: string): string {
  return new URL(ensureUrlLike(input)).origin
}

export function getPublicOrigin(request: Request): string {
  const proto = firstHeaderValue(request.headers, "x-forwarded-proto")
  const host = firstHeaderValue(request.headers, "x-forwarded-host")
  if (proto && host) {
    // Some proxies may already include a scheme in the host value.
    if (host.includes("://")) return normalizeOrigin(host)
    return normalizeOrigin(`${proto}://${host}`)
  }

  const requestOrigin = new URL(request.url).origin
  if (requestOrigin && requestOrigin !== "null") {
    return normalizeOrigin(requestOrigin)
  }

  const fallbackOrigin =
    process.env.APP_ORIGIN ??
    process.env.NEXT_PUBLIC_APP_ORIGIN ??
    process.env.NEXT_PUBLIC_APP_URL
  if (fallbackOrigin) {
    return normalizeOrigin(fallbackOrigin)
  }

  return requestOrigin
}
