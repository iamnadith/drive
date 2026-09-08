import { ensureDriveSchema, queryDb } from "./db"

const SETTINGS_KEY = "migration-workers"
const MIN_SECRET_LENGTH = 24
const MAX_SECRET_LENGTH = 512

export type MigrationWorkerSettings = {
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

function normalize(value: unknown, updatedAt?: string | null): MigrationWorkerSettings {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return {
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
  const saved = rows[0] ? normalize(rows[0].value, rows[0].updated_at) : { sharedSecret: "" }
  if (saved.sharedSecret.length >= MIN_SECRET_LENGTH && saved.sharedSecret.length <= MAX_SECRET_LENGTH) return saved
  const fallback = envSecret()
  return fallback.length >= MIN_SECRET_LENGTH && fallback.length <= MAX_SECRET_LENGTH
    ? { ...saved, sharedSecret: fallback }
    : saved
}

export async function getMigrationWorkerSharedSecret(): Promise<string> {
  return (await getMigrationWorkerSettings()).sharedSecret
}

export async function saveMigrationWorkerSettings(input: { sharedSecret?: unknown }): Promise<MigrationWorkerSettings> {
  const current = await getMigrationWorkerSettings()
  const requested = normalizeSecret(input.sharedSecret)
  const nextSecret = requested || current.sharedSecret
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
    [SETTINGS_KEY, JSON.stringify({ sharedSecret: nextSecret })]
  )
  return normalize(rows[0]?.value, rows[0]?.updated_at)
}

export function publicMigrationWorkerSettings(settings: MigrationWorkerSettings) {
  return {
    sharedSecret: settings.sharedSecret,
    secretConfigured: settings.sharedSecret.length >= MIN_SECRET_LENGTH && settings.sharedSecret.length <= MAX_SECRET_LENGTH,
    updatedAt: settings.updatedAt,
  }
}
