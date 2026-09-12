import { NextResponse, type NextRequest } from "next/server"

const INTERNAL_API_PREFIXES = [
  "/api/accounts",
  "/api/activity",
  "/api/agents",
  "/api/dashboard",
  "/api/github/connect",
  "/api/github/repos",
  "/api/github/workflows",
  "/api/migrations",
  "/api/projects",
  "/api/repair-jobs",
  "/api/storage",
  "/api/users",
  "/api/workers",
]

const PUBLIC_API_PREFIXES = [
  "/api/auth",
  "/api/public",
  "/api/setup",
  "/api/workers/cloudflare-install",
  "/api/v1",
  "/api/users/email-available",
  "/api/users/username-available",
]

const AGENT_TOKEN_API_PATTERNS = [
  /^\/api\/(?:agents|workers)\/[^/]+\/claim-job\/?$/,
  /^\/api\/(?:agents|workers)\/[^/]+\/heartbeat\/?$/,
  /^\/api\/(?:agents|workers)\/[^/]+\/jobs\/[^/]+\/?$/,
]

function isProtectedInternalApi(pathname: string) {
  if (!pathname.startsWith("/api/")) return false
  if (PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false
  if (AGENT_TOKEN_API_PATTERNS.some((pattern) => pattern.test(pathname))) return false
  return INTERNAL_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  if (!pathname.startsWith("/api/")) {
    const setupRequired = request.cookies.get("drive_setup_required")?.value
    if (setupRequired === "1" && pathname !== "/setup") return NextResponse.redirect(new URL("/setup", request.url))
    if (setupRequired === "0" && pathname === "/setup") return NextResponse.redirect(new URL("/", request.url))
    return NextResponse.next()
  }

  if (!isProtectedInternalApi(pathname)) {
    return NextResponse.next()
  }

  if (!request.cookies.get("sessionUserId")?.value) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/api/:path*", "/((?!_next/static|_next/image|favicon.ico).*)"],
}
