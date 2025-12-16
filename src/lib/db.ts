import { Pool } from "pg"
import type { QueryResultRow } from "pg"

declare global {
  var __drivePgPool: Pool | undefined
  var __driveEnsureSchema: Promise<void> | undefined
}

function getEnv(name: string): string | undefined {
  const value = process.env[name]
  return value && value.trim().length > 0 ? value : undefined
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === "1" || normalized === "true" || normalized === "yes")
    return true
  if (normalized === "0" || normalized === "false" || normalized === "no")
    return false
  return undefined
}

function buildSslConfig(): false | {
  rejectUnauthorized: boolean
  checkServerIdentity?: () => undefined
  servername?: string
} {
  const enabled = parseBooleanEnv(getEnv("POSTGRES_SSL")) ?? true
  if (!enabled) return false

  const rejectUnauthorized =
    parseBooleanEnv(getEnv("POSTGRES_SSL_REJECT_UNAUTHORIZED")) ?? false

  const disableHostnameVerification =
    parseBooleanEnv(getEnv("POSTGRES_SSL_DISABLE_HOSTNAME_VERIFICATION")) ?? true

  const servername = getEnv("POSTGRES_SSL_SERVERNAME")

  return {
    rejectUnauthorized,
    checkServerIdentity: disableHostnameVerification ? () => undefined : undefined,
    servername: servername ?? undefined,
  }
}

function getPoolMax(): number {
  const raw = getEnv("POSTGRES_POOL_MAX")
  const parsed = raw ? Number(raw) : NaN
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return process.env.NODE_ENV === "production" ? 5 : 1
}

function attachPoolErrorHandler(pool: Pool) {
  // Prevent process crashes from idle client errors (e.g. server terminating connections).
  pool.on("error", (error) => {
    console.error("Postgres pool error:", error)
    if (global.__drivePgPool === pool) {
      global.__drivePgPool = undefined
    }
    pool.end().catch(() => {})
  })
}

function isTransientConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const maybe = error as { code?: unknown; message?: unknown }
  const code = typeof maybe.code === "string" ? maybe.code : ""
  const message = typeof maybe.message === "string" ? maybe.message : ""

  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "57P01" || // admin_shutdown
    code === "57P02" || // crash_shutdown
    code === "57P03" || // cannot_connect_now
    message.includes("Connection terminated unexpectedly") ||
    message.includes("terminating connection due to administrator command") ||
    message.includes("{:shutdown, :db_termination}")
  )
}

export async function queryDb<T extends QueryResultRow = any>(
  text: string,
  params?: readonly unknown[]
) {
  const attempt = async () => {
    const pool = getDbPool()
    return pool.query<T>(text, params as unknown[] | undefined)
  }

  try {
    return await attempt()
  } catch (error) {
    if (!isTransientConnectionError(error)) {
      throw error
    }

    const existing = global.__drivePgPool
    global.__drivePgPool = undefined
    await existing?.end().catch(() => {})

    return attempt()
  }
}

export function isPostgresConfigured(): boolean {
  return Boolean(
    getEnv("POSTGRES_URL_NON_POOLING") ||
      getEnv("POSTGRES_URL") ||
      getEnv("POSTGRES_PRISMA_URL") ||
      (getEnv("POSTGRES_HOST") &&
        getEnv("POSTGRES_USER") &&
        getEnv("POSTGRES_PASSWORD") &&
        getEnv("POSTGRES_DATABASE"))
  )
}

export function getDbPool(): Pool {
  if (!global.__drivePgPool) {
    const host = getEnv("POSTGRES_HOST")
    const user = getEnv("POSTGRES_USER")
    const password = getEnv("POSTGRES_PASSWORD")
    const database = getEnv("POSTGRES_DATABASE")

    const ssl = buildSslConfig()

    const port = Number(getEnv("POSTGRES_PORT") ?? 5432)

    const urlString =
      getEnv("POSTGRES_URL_NON_POOLING") ??
      getEnv("POSTGRES_URL") ??
      getEnv("POSTGRES_PRISMA_URL")

    const preferUrl =
      parseBooleanEnv(getEnv("POSTGRES_PREFER_URL")) ??
      (() => {
        if (!urlString) return false
        try {
          const url = new URL(urlString)
          const hostname = url.hostname.toLowerCase()
          // Prefer a direct `db.<ref>.supabase.co` URL over other sources.
          return hostname.startsWith("db.") && hostname.includes(".supabase.co")
        } catch {
          return false
        }
      })()

    // Supabase pooler connections can be terminated by the pooler (e.g. `{:shutdown, :db_termination}`).
    // Prefer direct DB host config when available unless explicitly disabled.
    const preferHostConfig =
      parseBooleanEnv(getEnv("POSTGRES_USE_HOST_CONFIG")) ??
      (Boolean(host && user && password && database) && !preferUrl)

    if (preferHostConfig && host && user && password && database) {
      global.__drivePgPool = new Pool({
        host,
        port,
        user,
        password,
        database,
        ssl,
        keepAlive: true,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        max: getPoolMax(),
      })
      attachPoolErrorHandler(global.__drivePgPool)
      return global.__drivePgPool
    }

    if (urlString) {
      const url = new URL(urlString)

      global.__drivePgPool = new Pool({
        host: url.hostname,
        port: Number(url.port || 5432),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.startsWith("/")
          ? url.pathname.slice(1)
          : url.pathname,
        ssl,
        keepAlive: true,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        max: getPoolMax(),
      })
      attachPoolErrorHandler(global.__drivePgPool)
      return global.__drivePgPool
    }

    if (host && user && password && database) {
      global.__drivePgPool = new Pool({
        host,
        port,
        user,
        password,
        database,
        ssl,
        keepAlive: true,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        max: getPoolMax(),
      })
      attachPoolErrorHandler(global.__drivePgPool)
      return global.__drivePgPool
    }

    throw new Error("Postgres is not configured (missing POSTGRES_* variables)")
  }

  return global.__drivePgPool
}

export async function ensureDriveSchema(): Promise<void> {
  if (!isPostgresConfigured()) return

  if (!global.__driveEnsureSchema) {
    global.__driveEnsureSchema = (async () => {
      await queryDb(`create extension if not exists pgcrypto;`)

      await queryDb(`
        create table if not exists drive_users (
          id uuid primary key,
          name text not null,
          first_name text not null,
          last_name text,
          username text,
          email text not null,
          role text not null,
          status text not null,
          quota_limit_mb integer not null default 500,
          quota_used_mb integer not null default 0,
          profile_image_url text not null default '',
          google_linked boolean not null default false,
          google_sub text,
          password_source text not null default 'local',
          password_hash text not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(
        `create unique index if not exists drive_users_email_key on drive_users (email);`
      )
      await queryDb(
        `create unique index if not exists drive_users_username_key on drive_users (username) where username is not null;`
      )

      await queryDb(`
        create table if not exists drive_accounts (
          id uuid primary key,
          label text not null,
          email text not null,
          password text not null,
          created_at timestamptz not null default now(),
          two_factor_secret text,
          api_token text not null,
          r2_access_key_id text not null,
          r2_secret_access_key text not null,
          cloudflare_account_id text,
          cloudflare_account_name text,
          status text not null default 'available',
          last_migrated text default '-',
          total_buckets integer not null default 0,
          total_objects integer not null default 0,
          total_bytes bigint not null default 0,
          last_synced_at timestamptz,
          sync_status text default 'idle',
          sync_message text,
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(
        `create unique index if not exists drive_accounts_email_key on drive_accounts (email);`
      )
      await queryDb(
        `create unique index if not exists drive_accounts_api_token_key on drive_accounts (api_token);`
      )
      await queryDb(
        `create unique index if not exists drive_accounts_r2_access_key_id_key on drive_accounts (r2_access_key_id);`
      )
      await queryDb(
        `create unique index if not exists drive_accounts_label_ci_key on drive_accounts ((lower(label)));`
      )
      await queryDb(
        `create unique index if not exists drive_accounts_one_active_key on drive_accounts ((status)) where status = 'active';`
      )
    })()
  }

  return global.__driveEnsureSchema
}
