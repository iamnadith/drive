import { ensureDriveSchema, queryDb } from "./db"

const SETTINGS_KEY = "backend-orchestrator"

export type BackendOrchestratorSettings = {
  enabled: boolean
  orchestratorUrl: string
  sharedSecret: string
  syncIntervalMinutes: number
  updatedAt?: string
}

type SettingsRow = {
  value: unknown
  updated_at: string | null
}

const DEFAULTS: BackendOrchestratorSettings = {
  enabled: false,
  orchestratorUrl: "",
  sharedSecret: "",
  syncIntervalMinutes: 1,
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return ""
  const url = new URL(value.trim())
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Backend Orchestrator URL must use HTTPS")
  }
  return url.toString().replace(/\/$/, "")
}

function normalize(value: unknown, updatedAt?: string | null): BackendOrchestratorSettings {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const sharedSecret = typeof row.sharedSecret === "string" ? row.sharedSecret.trim() : ""
  return {
    enabled: row.enabled === true,
    orchestratorUrl: normalizeUrl(row.orchestratorUrl),
    sharedSecret,
    syncIntervalMinutes: 1,
    updatedAt: updatedAt ?? undefined,
  }
}

export async function getBackendOrchestratorSettings(): Promise<BackendOrchestratorSettings> {
  await ensureDriveSchema()
  const { rows } = await queryDb<SettingsRow>(
    `select value, updated_at from drive_app_settings where key = $1 limit 1`,
    [SETTINGS_KEY]
  )
  return rows[0] ? normalize(rows[0].value, rows[0].updated_at) : { ...DEFAULTS }
}

export async function saveBackendOrchestratorSettings(input: {
  enabled?: unknown
  orchestratorUrl?: unknown
  sharedSecret?: unknown
  syncIntervalMinutes?: unknown
}): Promise<BackendOrchestratorSettings> {
  const current = await getBackendOrchestratorSettings()
  const next = normalize({
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    orchestratorUrl: input.orchestratorUrl === undefined ? current.orchestratorUrl : input.orchestratorUrl,
    sharedSecret:
      typeof input.sharedSecret === "string" && input.sharedSecret.trim()
        ? input.sharedSecret.trim()
        : current.sharedSecret,
    syncIntervalMinutes:
      typeof input.syncIntervalMinutes === "number" ? input.syncIntervalMinutes : current.syncIntervalMinutes,
  })
  if (next.enabled && (!next.orchestratorUrl || next.sharedSecret.length < 24)) {
    throw new Error("Enabled Backend Orchestrator requires its URL and a shared secret of at least 24 characters")
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

export function publicBackendOrchestratorSettings(settings: BackendOrchestratorSettings) {
  return {
    enabled: settings.enabled,
    orchestratorUrl: settings.orchestratorUrl,
    secretConfigured: settings.sharedSecret.length >= 24,
    syncIntervalMinutes: settings.syncIntervalMinutes,
    updatedAt: settings.updatedAt,
  }
}
