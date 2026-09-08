import { ensureDriveSchema, queryDb } from "./db"

const SETTINGS_KEY = "migration-workers"
const MIN_SECRET_LENGTH = 24
const MAX_SECRET_LENGTH = 512

export type MigrationWorkerSettings = {
  serverUrl: string
  sharedSecret: string
  updatedAt?: string
}

type SettingsRow = {
  value: unknown
  updated_at: string | null
}

function normalizeSecret(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return ""
  const url = new URL(value.trim())
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Migration Worker URL must use HTTPS")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Migration Worker URL must not contain credentials, a query string, or a fragment")
  }
  return url.toString().replace(/\/$/, "")
}

function normalize(value: unknown, updatedAt?: string | null): MigrationWorkerSettings {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return {
    serverUrl: normalizeUrl(row.serverUrl),
    sharedSecret: normalizeSecret(row.sharedSecret),
    updatedAt: updatedAt ?? undefined,
  }
}

function envSecret(): string {
  return normalizeSecret(process.env.MIGRATION_WORKER_SHARED_SECRET)
}

export async function getMigrationWorkerSettings(): Promise<MigrationWorkerSettings> {
  await ensureDriveSchema()
  const { rows } = await queryDb<SettingsRow>(
    `select value, updated_at from drive_app_settings where key = $1 limit 1`,
    [SETTINGS_KEY]
  )
  const saved = rows[0] ? normalize(rows[0].value, rows[0].updated_at) : { serverUrl: "", sharedSecret: "" }
  if (saved.sharedSecret.length >= MIN_SECRET_LENGTH && saved.sharedSecret.length <= MAX_SECRET_LENGTH) return saved
  const fallback = envSecret()
  return fallback.length >= MIN_SECRET_LENGTH && fallback.length <= MAX_SECRET_LENGTH
    ? { ...saved, sharedSecret: fallback }
    : saved
}

export async function getMigrationWorkerSharedSecret(): Promise<string> {
  return (await getMigrationWorkerSettings()).sharedSecret
}

export async function saveMigrationWorkerSettings(input: { serverUrl?: unknown; sharedSecret?: unknown }): Promise<MigrationWorkerSettings> {
  const current = await getMigrationWorkerSettings()
  const requested = normalizeSecret(input.sharedSecret)
  const nextSecret = requested || current.sharedSecret
  const serverUrl = input.serverUrl === undefined ? current.serverUrl : normalizeUrl(input.serverUrl)
  if (nextSecret && nextSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`Migration worker shared secret must be at least ${MIN_SECRET_LENGTH} characters`)
  }
  if (nextSecret.length > MAX_SECRET_LENGTH) {
    throw new Error(`Migration worker shared secret must be at most ${MAX_SECRET_LENGTH} characters`)
  }

  const { rows } = await queryDb<SettingsRow>(
    `
      insert into drive_app_settings (key, value, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
      returning value, updated_at
    `,
    [SETTINGS_KEY, JSON.stringify({ serverUrl, sharedSecret: nextSecret })]
  )
  return normalize(rows[0]?.value, rows[0]?.updated_at)
}

export function publicMigrationWorkerSettings(settings: MigrationWorkerSettings) {
  return {
    serverUrl: settings.serverUrl,
    sharedSecret: settings.sharedSecret,
    secretConfigured: settings.sharedSecret.length >= MIN_SECRET_LENGTH && settings.sharedSecret.length <= MAX_SECRET_LENGTH,
    updatedAt: settings.updatedAt,
  }
}
