import { ensureDriveSchema, queryDb } from "./db"

const SETTINGS_KEY = "migration-orchestrator"
const MIN_SECRET_LENGTH = 24
const MAX_SECRET_LENGTH = 512

export type MigrationOrchestratorSettings = {
  enabled: boolean
  migrationEnabled: boolean
  fileScannerEnabled: boolean
  orchestratorUrl: string
  fileScannerUrl: string
  sharedSecret: string
  fileScannerSecret: string
  updatedAt?: string
}

type SettingsRow = { value: unknown; updated_at: string | null }

const DEFAULTS: MigrationOrchestratorSettings = { enabled: false, migrationEnabled: false, fileScannerEnabled: false, orchestratorUrl: "", fileScannerUrl: "", sharedSecret: "", fileScannerSecret: "" }

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
  const legacyEnabled = row.enabled === true
  return {
    enabled: legacyEnabled,
    migrationEnabled: typeof row.migrationEnabled === "boolean" ? row.migrationEnabled : legacyEnabled,
    fileScannerEnabled: typeof row.fileScannerEnabled === "boolean" ? row.fileScannerEnabled : legacyEnabled,
    orchestratorUrl: normalizeUrl(row.orchestratorUrl),
    fileScannerUrl: normalizeUrl(row.fileScannerUrl ?? row.fileOrchestratorUrl),
    sharedSecret: typeof row.sharedSecret === "string" ? row.sharedSecret.trim() : "",
    fileScannerSecret: typeof row.fileScannerSecret === "string" ? row.fileScannerSecret.trim() : "",
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
  migrationEnabled?: unknown
  fileScannerEnabled?: unknown
  orchestratorUrl?: unknown
  fileScannerUrl?: unknown
  sharedSecret?: unknown
  fileScannerSecret?: unknown
}): Promise<MigrationOrchestratorSettings> {
  const current = await getMigrationOrchestratorSettings()
  const secret = typeof input.sharedSecret === "string" && input.sharedSecret.trim()
    ? input.sharedSecret.trim()
    : current.sharedSecret
  const scannerSecret = typeof input.fileScannerSecret === "string" && input.fileScannerSecret.trim()
    ? input.fileScannerSecret.trim()
    : current.fileScannerSecret
  const next = normalize({
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    migrationEnabled: typeof input.migrationEnabled === "boolean" ? input.migrationEnabled : current.migrationEnabled,
    fileScannerEnabled: typeof input.fileScannerEnabled === "boolean" ? input.fileScannerEnabled : current.fileScannerEnabled,
    orchestratorUrl: input.orchestratorUrl === undefined ? current.orchestratorUrl : input.orchestratorUrl,
    fileScannerUrl: input.fileScannerUrl === undefined ? current.fileScannerUrl : input.fileScannerUrl,
    sharedSecret: secret,
    fileScannerSecret: scannerSecret,
  })
  if (next.sharedSecret.length > MAX_SECRET_LENGTH) {
    throw new Error(`Migration Orchestrator shared secret must be at most ${MAX_SECRET_LENGTH} characters`)
  }
  if (next.fileScannerSecret.length > MAX_SECRET_LENGTH) throw new Error(`File Scanner secret must be at most ${MAX_SECRET_LENGTH} characters`)
  if (next.migrationEnabled && (!next.orchestratorUrl || next.sharedSecret.length < MIN_SECRET_LENGTH)) throw new Error(`Migration Orchestrator requires its URL and secret of at least ${MIN_SECRET_LENGTH} characters`)
  if (next.fileScannerEnabled && (!next.fileScannerUrl || next.fileScannerSecret.length < MIN_SECRET_LENGTH)) throw new Error(`File Scanner requires its URL and secret of at least ${MIN_SECRET_LENGTH} characters`)
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
    migrationEnabled: settings.migrationEnabled,
    fileScannerEnabled: settings.fileScannerEnabled,
    orchestratorUrl: settings.orchestratorUrl,
    fileScannerUrl: settings.fileScannerUrl,
    sharedSecret: settings.sharedSecret,
    fileScannerSecret: settings.fileScannerSecret,
    secretConfigured: settings.sharedSecret.length >= MIN_SECRET_LENGTH && settings.sharedSecret.length <= MAX_SECRET_LENGTH,
    fileScannerSecretConfigured: settings.fileScannerSecret.length >= MIN_SECRET_LENGTH && settings.fileScannerSecret.length <= MAX_SECRET_LENGTH,
    updatedAt: settings.updatedAt,
  }
}
