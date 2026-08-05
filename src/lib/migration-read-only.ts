const TERMINAL_HISTORY_GRACE_MS = 7 * 24 * 60 * 60 * 1000

type MigrationLike = {
  status?: string
  completedAt?: string
  syncMessage?: string
  options?: {
    historyReadOnlyAt?: string
    historyReadOnlyReason?: string
  }
}

export function isPermanentAccountCommunicationFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  return [
    "authentication",
    "unauthorized",
    "forbidden",
    "invalid api token",
    "invalid access key",
    "account is disabled",
    "account is deactivated",
    "account not found",
    "missing cloudflare",
    "missing r2 credentials",
    "please enable r2",
    "r2 is disabled",
    "r2 disabled",
    "fetch failed",
    "network error",
    "timed out",
    "timeout",
    "econnreset",
    "cloudflare api request failed",
  ].some((fragment) => normalized.includes(fragment))
}

export function getMigrationReadOnlyState(migration: MigrationLike): {
  readOnly: boolean
  reason: string | null
} {
  if (migration.options?.historyReadOnlyAt) {
    return {
      readOnly: true,
      reason: migration.options.historyReadOnlyReason || "Account communication is unavailable",
    }
  }

  const terminal = ["completed", "failed", "canceled"].includes(String(migration.status ?? "").toLowerCase())
  const completedAt = migration.completedAt ? Date.parse(migration.completedAt) : Number.NaN
  if (terminal && Number.isFinite(completedAt) && Date.now() - completedAt >= TERMINAL_HISTORY_GRACE_MS) {
    return { readOnly: true, reason: "Terminal migration history older than 7 days" }
  }

  return { readOnly: false, reason: null }
}
