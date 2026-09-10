import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import nextEnv from "@next/env"
import pg from "pg"

const { loadEnvConfig } = nextEnv
const { Client } = pg
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// Keep local builds consistent with Next.js and allow Vercel's build
// environment to use its configured production variables.
loadEnvConfig(projectRoot, false, true)

function value(name) {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : undefined
}

function valueForBoolean(name) {
  const raw = value(name)
  return raw?.toLowerCase()
}

function booleanValue(name, fallback) {
  const parsed = valueForBoolean(name)
  if (parsed === undefined) return fallback
  if (["1", "true", "yes"].includes(parsed)) return true
  if (["0", "false", "no"].includes(parsed)) return false
  return fallback
}

function sslConfig() {
  if (!booleanValue("POSTGRES_SSL", true)) return false
  const rejectUnauthorized = booleanValue(
    "POSTGRES_SSL_REJECT_UNAUTHORIZED",
    false
  )
  const disableHostnameVerification = booleanValue(
    "POSTGRES_SSL_DISABLE_HOSTNAME_VERIFICATION",
    true
  )
  const servername = value("POSTGRES_SSL_SERVERNAME")
  return {
    rejectUnauthorized,
    ...(disableHostnameVerification
      ? { checkServerIdentity: () => undefined }
      : {}),
    ...(servername ? { servername } : {}),
  }
}

function connectionConfig() {
  const url =
    value("POSTGRES_URL_NON_POOLING") ??
    value("POSTGRES_URL") ??
    value("POSTGRES_PRISMA_URL")
  const host = value("POSTGRES_HOST")
  const user = value("POSTGRES_USER")
  const password = value("POSTGRES_PASSWORD")
  const database = value("POSTGRES_DATABASE")
  const port = Number(value("POSTGRES_PORT") ?? 5432)

  if (url) {
    let preferHostConfig = false
    try {
      const parsed = new URL(url)
      const prefersDirectSupabase =
        parsed.hostname.toLowerCase().startsWith("db.") &&
        parsed.hostname.toLowerCase().includes(".supabase.co")
      preferHostConfig =
        booleanValue("POSTGRES_USE_HOST_CONFIG", undefined) ??
        Boolean(host && user && password && database && !prefersDirectSupabase)
    } catch {
      preferHostConfig = false
    }

    if (!preferHostConfig) return { connectionString: url }
  }

  if (host && user && password && database) {
    return { host, user, password, database, port }
  }

  throw new Error(
    "Postgres is not configured. Set POSTGRES_URL (or POSTGRES_URL_NON_POOLING) in the build environment."
  )
}

function databaseLabel(config) {
  if (config.connectionString) {
    try {
      const parsed = new URL(config.connectionString)
      return parsed.hostname
    } catch {
      return "configured database"
    }
  }
  return `${config.host}:${config.port}/${config.database}`
}

async function main() {
  if (booleanValue("DRIVE_SKIP_SCHEMA_BUILD", false)) {
    console.warn(
      "[db:schema] skipped because DRIVE_SKIP_SCHEMA_BUILD is enabled"
    )
    return
  }

  const schemaPath = resolve(projectRoot, "supabase", "drive_schema.sql")
  const schema = await readFile(schemaPath, "utf8")
  const config = connectionConfig()

  console.log(`[db:schema] applying ${schemaPath} to ${databaseLabel(config)}`)

  if (booleanValue("DRIVE_SCHEMA_DRY_RUN", false)) {
    console.log("[db:schema] dry run complete; no database was changed")
    return
  }

  const maxAttempts = 4
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = new Client({
      ...config,
      ssl: sslConfig(),
      connectionTimeoutMillis: 15_000,
      application_name: "drive-build-schema",
    })
    let connected = false
    let locked = false
    try {
      await client.connect()
      connected = true
      // Serialize panel schema installers. Runtime workers may still perform
      // idempotent schema guards, so retry transaction-level deadlocks below.
      const lockResult = await client.query("select pg_try_advisory_lock(hashtext($1)) acquired", ["drive-schema-install-v1"])
      locked = lockResult.rows[0]?.acquired === true
      if (!locked) {
        console.warn("[db:schema] another deployment is already preparing this schema; continuing without a duplicate installer")
        return
      }
      await client.query("begin")
      await client.query("set local lock_timeout = '60s'")
      await client.query("set local statement_timeout = '10min'")
      await client.query(schema)
      await client.query("commit")
      console.log("[db:schema] schema is ready")
      return
    } catch (error) {
      if (connected) await client.query("rollback").catch(() => undefined)
      const code = error && typeof error === "object" && "code" in error ? String(error.code ?? "") : ""
      const retryable = ["40P01", "55P03", "57014"].includes(code)
      if (retryable && attempt < maxAttempts) {
        const delayMs = attempt * 1_000
        console.warn(`[db:schema] transient database lock (${code}); retrying attempt ${attempt + 1}/${maxAttempts}`)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
        continue
      }
      const details =
        error && typeof error === "object"
          ? {
              code: "code" in error ? error.code : undefined,
              message: "message" in error ? error.message : String(error),
            }
          : { message: String(error) }
      console.error("[db:schema] schema preparation failed", details)
      process.exitCode = 1
      return
    } finally {
      if (locked) await client.query("select pg_advisory_unlock(hashtext($1))", ["drive-schema-install-v1"]).catch(() => undefined)
      await client.end().catch(() => undefined)
    }
  }
}

await main()
