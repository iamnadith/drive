function firstHeaderValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)
  if (!value) return undefined
  return value.split(",")[0]?.trim() || undefined
}

function normalizeOrigin(input: string): string {
  return new URL(input).origin
}

export function getPublicOrigin(request: Request): string {
  const envOrigin =
    process.env.APP_ORIGIN ??
    process.env.NEXT_PUBLIC_APP_ORIGIN ??
    process.env.NEXT_PUBLIC_APP_URL

  if (envOrigin) {
    return normalizeOrigin(envOrigin)
  }

  const proto = firstHeaderValue(request.headers, "x-forwarded-proto")
  const host = firstHeaderValue(request.headers, "x-forwarded-host")
  if (proto && host) {
    return normalizeOrigin(`${proto}://${host}`)
  }

  return new URL(request.url).origin
}

