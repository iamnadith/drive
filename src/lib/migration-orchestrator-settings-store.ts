import { ensureDriveSchema, queryDb } from "./db"

const SETTINGS_KEY = "migration-orchestrator"
const MIN_SECRET_LENGTH = 24
const MAX_SECRET_LENGTH = 512

export type MigrationOrchestratorSettings = {
  enabled: boolean
  orchestratorUrl: string
  sharedSecret: string
  updatedAt?: string
}

type SettingsRow = { value: unknown; updated_at: string | null }

const DEFAULTS: MigrationOrchestratorSettings = { enabled: false, orchestratorUrl: "", sharedSecret: "" }

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return ""
  const url = new URL(value.trim())
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("Migration Orchestrator URL must use HTTPS")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Migration Orchestrator URL must not contain credentials, a query string, or a fragment")
  }
  return url.toString().replace(/\/$/, "")
}

function normalize(value: unknown, updatedAt?: string | null): MigrationOrchestratorSettings {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return {
    enabled: row.enabled === true,
    orchestratorUrl: normalizeUrl(row.orchestratorUrl),
    sharedSecret: typeof row.sharedSecret === "string" ? row.sharedSecret.trim() : "",
    updatedAt: updatedAt ?? undefined,
  }
}

export async function getMigrationOrchestratorSettings(): Promise<MigrationOrchestratorSettings> {
  await ensureDriveSchema()
  const { rows } = await queryDb<SettingsRow>(
    `select value, updated_at from drive_app_settings where key = $1 limit 1`,
    [SETTINGS_KEY]
  )
  return rows[0] ? normalize(rows[0].value, rows[0].updated_at) : { ...DEFAULTS }
}

export async function saveMigrationOrchestratorSettings(input: {
  enabled?: unknown
  orchestratorUrl?: unknown
  sharedSecret?: unknown
}): Promise<MigrationOrchestratorSettings> {
  const current = await getMigrationOrchestratorSettings()
  const secret = typeof input.sharedSecret === "string" && input.sharedSecret.trim()
    ? input.sharedSecret.trim()
    : current.sharedSecret
  const next = normalize({
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    orchestratorUrl: input.orchestratorUrl === undefined ? current.orchestratorUrl : input.orchestratorUrl,
    sharedSecret: secret,
  })
  if (next.sharedSecret.length > MAX_SECRET_LENGTH) {
    throw new Error(`Migration Orchestrator shared secret must be at most ${MAX_SECRET_LENGTH} characters`)
  }
  if (next.enabled && (!next.orchestratorUrl || next.sharedSecret.length < MIN_SECRET_LENGTH)) {
    throw new Error(`Enabled Migration Orchestrator requires its URL and a shared secret of at least ${MIN_SECRET_LENGTH} characters`)
  }
  const { rows } = await queryDb<SettingsRow>(
    `
      insert into drive_app_settings (key, value, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
      returning value, updated_at
    `,
    [SETTINGS_KEY, JSON.stringify(next)]
  )
  return normalize(rows[0]?.value, rows[0]?.updated_at)
}

export function publicMigrationOrchestratorSettings(settings: MigrationOrchestratorSettings) {
  return {
    enabled: settings.enabled,
    orchestratorUrl: settings.orchestratorUrl,
    secretConfigured: settings.sharedSecret.length >= MIN_SECRET_LENGTH && settings.sharedSecret.length <= MAX_SECRET_LENGTH,
    updatedAt: settings.updatedAt,
  }
}
