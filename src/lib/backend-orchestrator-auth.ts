import crypto from "crypto"
import { getBackendOrchestratorSettings } from "./backend-orchestrator-settings-store"

function tokenFromRequest(request: Request): string {
  const authorization = request.headers.get("authorization") ?? ""
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim()
  return request.headers.get("x-drive-orchestrator-secret")?.trim() ?? ""
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export async function authenticateBackendOrchestrator(request: Request) {
  const settings = await getBackendOrchestratorSettings()
  const token = tokenFromRequest(request)
  return {
    ok: settings.enabled && settings.sharedSecret.length >= 24 && safeEqual(token, settings.sharedSecret),
    settings,
  }
}
