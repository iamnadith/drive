import crypto from "crypto"
import { getMigrationOrchestratorSettings } from "./migration-orchestrator-settings-store"

const MAX_SECRET_LENGTH = 512

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

export async function authenticateMigrationOrchestrator(request: Request) {
  const settings = await getMigrationOrchestratorSettings()
  const token = tokenFromRequest(request)
  return {
    ok:
      settings.sharedSecret.length >= 24 &&
      settings.sharedSecret.length <= MAX_SECRET_LENGTH &&
      token.length <= MAX_SECRET_LENGTH &&
      safeEqual(token, settings.sharedSecret),
    settings,
  }
}
