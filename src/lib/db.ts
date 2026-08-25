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
    message.includes("Connection terminated due to connection timeout") ||
    message.includes("terminating connection due to administrator command") ||
    message.includes("{:shutdown, :db_termination}")
  )
}

export async function queryDb<T extends QueryResultRow = QueryResultRow>(
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
          email_verified boolean not null default false,
          email_verified_at timestamptz,
          password_source text not null default 'local',
          two_factor_enabled boolean not null default false,
          totp_enabled boolean not null default false,
          totp_secret text,
          totp_last_used_counter bigint,
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
      await queryDb(`alter table if exists drive_users add column if not exists email_verified boolean not null default true;`)
      await queryDb(`alter table if exists drive_users add column if not exists email_verified_at timestamptz;`)
      await queryDb(`alter table if exists drive_users add column if not exists two_factor_enabled boolean not null default false;`)
      await queryDb(`alter table if exists drive_users add column if not exists totp_enabled boolean not null default false;`)
      await queryDb(`alter table if exists drive_users add column if not exists totp_secret text;`)
      await queryDb(`alter table if exists drive_users add column if not exists totp_last_used_counter bigint;`)
      await queryDb(`
        create table if not exists drive_email_verification_tokens (
          id uuid primary key default gen_random_uuid(),
          user_id uuid not null references drive_users(id) on delete cascade,
          token_hash text not null,
          email text not null,
          purpose text not null default 'signup',
          attempts integer not null default 0,
          expires_at timestamptz not null,
          consumed_at timestamptz,
          created_at timestamptz not null default now()
        );
      `)
      await queryDb(`drop index if exists drive_email_verification_tokens_hash_key;`)
      await queryDb(`create index if not exists drive_email_verification_tokens_hash_idx on drive_email_verification_tokens (token_hash);`)
      await queryDb(`alter table if exists drive_email_verification_tokens add column if not exists purpose text not null default 'signup';`)
      await queryDb(`alter table if exists drive_email_verification_tokens add column if not exists attempts integer not null default 0;`)
      await queryDb(`create index if not exists drive_email_verification_tokens_user_idx on drive_email_verification_tokens (user_id, purpose, created_at desc);`)
      await queryDb(`create index if not exists drive_email_verification_tokens_expires_idx on drive_email_verification_tokens (expires_at);`)
      await queryDb(`create index if not exists drive_email_verification_tokens_email_purpose_idx on drive_email_verification_tokens (email, purpose, created_at desc);`)

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

      await queryDb(`
        create table if not exists drive_bucket_stats (
          id uuid primary key,
          account_id uuid not null references drive_accounts(id) on delete cascade,
          bucket_name text not null,
          objects bigint not null default 0,
          bytes bigint not null default 0,
          continuation_token text,
          status text not null default 'pending',
          error text,
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(
        `create unique index if not exists drive_bucket_stats_unique on drive_bucket_stats (account_id, bucket_name);`
      )
      await queryDb(
        `create index if not exists drive_bucket_stats_account_idx on drive_bucket_stats (account_id);`
      )
      await queryDb(
        `create index if not exists drive_bucket_stats_status_idx on drive_bucket_stats (status);`
      )

      await queryDb(`
        create table if not exists drive_projects (
          id uuid primary key default gen_random_uuid(),
          project_id text not null,
          name text not null,
          bucket_name text not null,
          status text not null default 'active',
          created_account_id uuid references drive_accounts(id) on delete set null,
          created_account_label text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`alter table public.drive_projects add column if not exists created_account_id uuid references drive_accounts(id) on delete set null;`)
      await queryDb(`alter table public.drive_projects add column if not exists created_account_label text;`)
      await queryDb(`alter table public.drive_projects alter column bucket_name drop not null;`)
      await queryDb(`update public.drive_projects set bucket_name = '' where bucket_name is null;`)
      await queryDb(`alter table public.drive_projects alter column bucket_name set default '';`)
      await queryDb(`alter table public.drive_projects alter column bucket_name set not null;`)
      await queryDb(`
        do $$
        declare
          id_data_type text;
          pk_name text;
        begin
          select c.data_type
          into id_data_type
          from information_schema.columns c
          where c.table_schema = 'public'
            and c.table_name = 'drive_projects'
            and c.column_name = 'id';

          if id_data_type is not null and id_data_type <> 'uuid' then
            alter table public.drive_projects add column if not exists legacy_id text;

            update public.drive_projects
            set legacy_id = id::text
            where legacy_id is null;

            select conname
            into pk_name
            from pg_constraint
            where conrelid = 'public.drive_projects'::regclass
              and contype = 'p'
            limit 1;

            if pk_name is not null then
              execute format('alter table public.drive_projects drop constraint %I', pk_name);
            end if;

            alter table public.drive_projects rename column id to old_text_id;
            alter table public.drive_projects alter column old_text_id drop not null;
            alter table public.drive_projects add column id uuid default gen_random_uuid();

            update public.drive_projects
            set id = case
              when old_text_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then old_text_id::text::uuid
              else gen_random_uuid()
            end;

            alter table public.drive_projects alter column id set not null;
            alter table public.drive_projects add primary key (id);
          end if;
        end $$;
      `)
      await queryDb(`
        do $$
        begin
          if exists (
            select 1
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'drive_projects'
              and column_name = 'active_account_id'
          ) then
            update public.drive_projects
            set created_account_id = active_account_id
            where created_account_id is null
              and active_account_id is not null;

            if exists (
              select 1
              from information_schema.columns
              where table_schema = 'public'
                and table_name = 'drive_projects'
                and column_name = 'active_account_id'
                and is_nullable = 'NO'
            ) then
              alter table public.drive_projects alter column active_account_id drop not null;
            end if;
          end if;
        end $$;
      `)
      await queryDb(`
        do $$
        begin
          if exists (
            select 1
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'drive_projects'
              and column_name = 'old_text_id'
              and is_nullable = 'NO'
          ) then
            alter table public.drive_projects alter column old_text_id drop not null;
          end if;
        end $$;
      `)
      await queryDb(`
        do $$
        declare
          legacy_column text;
        begin
          foreach legacy_column in array array['api_key_hash', 'api_key_prefix', 'api_key_name', 'api_key', 'bucket_id']
          loop
            if exists (
              select 1
              from information_schema.columns
              where table_schema = 'public'
                and table_name = 'drive_projects'
                and column_name = legacy_column
                and is_nullable = 'NO'
            ) then
              execute format(
                'alter table public.drive_projects alter column %I drop not null',
                legacy_column
              );
            end if;
          end loop;
        end $$;
      `)
      await queryDb(`drop index if exists drive_projects_bucket_name_key;`)
      await queryDb(`create unique index if not exists drive_projects_project_id_key on drive_projects (project_id);`)
      await queryDb(`create unique index if not exists drive_projects_bucket_name_key on drive_projects (bucket_name) where bucket_name <> '';`)
      await queryDb(`create index if not exists drive_projects_status_idx on drive_projects (status);`)
      await queryDb(`
        create table if not exists drive_project_bucket_assignments (
          project_id uuid not null references drive_projects(id) on delete cascade,
          bucket_name text not null,
          is_primary boolean not null default false,
          created_at timestamptz not null default now(),
          primary key (project_id, bucket_name)
        );
      `)
      await queryDb(`alter table public.drive_project_bucket_assignments drop column if exists media_allowed_origins;`)
      await queryDb(`alter table public.drive_project_bucket_assignments drop column if exists public_access_enabled;`)
      await queryDb(`create unique index if not exists drive_project_bucket_assignments_bucket_key on drive_project_bucket_assignments (bucket_name);`)
      await queryDb(`create unique index if not exists drive_project_bucket_assignments_primary_idx on drive_project_bucket_assignments (project_id) where is_primary = true;`)
      await queryDb(`
        create table if not exists drive_bucket_delivery_settings (
          account_id uuid not null references drive_accounts(id) on delete cascade,
          bucket_name text not null,
          public_access_enabled boolean not null default true,
          media_allowed_origins text[],
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          primary key (account_id, bucket_name)
        );
      `)
      await queryDb(`
        create table if not exists drive_project_delivery_settings (
          project_id uuid primary key references drive_projects(id) on delete cascade,
          media_allowed_origins text[],
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`
        insert into drive_project_bucket_assignments (project_id, bucket_name, is_primary)
        select p.id, p.bucket_name, true
        from drive_projects p
        where p.bucket_name <> ''
          and not exists (
            select 1
            from drive_project_bucket_assignments a
            where a.project_id = p.id
              and a.bucket_name = p.bucket_name
          );
      `)

      await queryDb(`
        create table if not exists drive_project_api_keys (
          id uuid primary key default gen_random_uuid(),
          name text not null,
          key_prefix text not null,
          key_hash text not null,
          status text not null default 'active',
          expires_at timestamptz,
          last_used_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`create unique index if not exists drive_project_api_keys_hash_key on drive_project_api_keys (key_hash);`)
      await queryDb(`create index if not exists drive_project_api_keys_status_idx on drive_project_api_keys (status);`)

      await queryDb(`
        create table if not exists drive_project_api_key_assignments (
          id uuid primary key default gen_random_uuid(),
          project_id uuid not null references drive_projects(id) on delete cascade,
          api_key_id uuid not null references drive_project_api_keys(id) on delete cascade,
          permissions jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`
        create unique index if not exists drive_project_api_key_assignments_unique
          on drive_project_api_key_assignments (project_id, api_key_id);
      `)
      await queryDb(`create index if not exists drive_project_api_key_assignments_key_idx on drive_project_api_key_assignments (api_key_id);`)

      await queryDb(`
        create table if not exists drive_project_file_links (
          id uuid primary key default gen_random_uuid(),
          project_id uuid not null references drive_projects(id) on delete cascade,
          file_id text,
          object_key text not null,
          bucket_name text,
          token_hash text not null,
          mode text not null,
          expires_at timestamptz,
          revoked_at timestamptz,
          created_at timestamptz not null default now()
        );
      `)
      await queryDb(`alter table public.drive_project_file_links add column if not exists file_id text;`)
      await queryDb(`alter table public.drive_project_file_links add column if not exists bucket_name text;`)
      await queryDb(`
        update drive_project_file_links l
        set bucket_name = p.bucket_name
        from drive_projects p
        where l.project_id = p.id
          and l.bucket_name is null;
      `)
      await queryDb(`create unique index if not exists drive_project_file_links_token_hash_key on drive_project_file_links (token_hash);`)
      await queryDb(`create index if not exists drive_project_file_links_file_idx on drive_project_file_links (file_id);`)
      await queryDb(`create index if not exists drive_project_file_links_project_idx on drive_project_file_links (project_id, object_key);`)
      await queryDb(`create index if not exists drive_project_file_links_active_idx on drive_project_file_links (mode, revoked_at, expires_at);`)

      await queryDb(`
        create table if not exists drive_project_operation_jobs (
          id uuid primary key default gen_random_uuid(),
          project_id uuid not null references drive_projects(id) on delete cascade,
          type text not null,
          status text not null default 'queued',
          payload jsonb not null default '{}'::jsonb,
          progress jsonb not null default '{}'::jsonb,
          result jsonb not null default '{}'::jsonb,
          error text,
          idempotency_key text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          started_at timestamptz,
          completed_at timestamptz
        );
      `)
      await queryDb(`create index if not exists drive_project_operation_jobs_project_idx on drive_project_operation_jobs (project_id, created_at desc);`)
      await queryDb(`create index if not exists drive_project_operation_jobs_status_idx on drive_project_operation_jobs (status, created_at);`)
      await queryDb(`
        create unique index if not exists drive_project_operation_jobs_idempotency_key
          on drive_project_operation_jobs (project_id, idempotency_key)
          where idempotency_key is not null;
      `)

      await queryDb(`
        create table if not exists drive_project_api_events (
          id uuid primary key default gen_random_uuid(),
          occurred_at timestamptz not null default now(),
          project_id uuid references drive_projects(id) on delete cascade,
          api_key_id uuid references drive_project_api_keys(id) on delete set null,
          action text not null,
          object_key text,
          status integer,
          outcome text not null default 'success',
          ip_address text,
          user_agent text,
          request_id text,
          metadata jsonb not null default '{}'::jsonb
        );
      `)
      await queryDb(`create index if not exists drive_project_api_events_project_time_idx on drive_project_api_events (project_id, occurred_at desc);`)
      await queryDb(`create index if not exists drive_project_api_events_key_time_idx on drive_project_api_events (api_key_id, occurred_at desc);`)
      await queryDb(`create index if not exists drive_project_api_events_action_time_idx on drive_project_api_events (action, occurred_at desc);`)

      await queryDb(`
        create table if not exists drive_project_object_inventory (
          project_id uuid not null references drive_projects(id) on delete cascade,
          bucket_name text not null,
          object_key text not null,
          size bigint not null default 0,
          etag text,
          content_type text,
          metadata jsonb not null default '{}'::jsonb,
          last_modified timestamptz,
          deleted_at timestamptz,
          updated_at timestamptz not null default now(),
          primary key (project_id, bucket_name, object_key)
        );
      `)
      await queryDb(`alter table public.drive_project_object_inventory add column if not exists bucket_name text;`)
      await queryDb(`alter table public.drive_project_object_inventory add column if not exists file_id text;`)
      await queryDb(`
        update drive_project_object_inventory i
        set bucket_name = coalesce(nullif(p.bucket_name, ''), '')
        from drive_projects p
        where p.id = i.project_id
          and i.bucket_name is null;
      `)
      await queryDb(`update public.drive_project_object_inventory set bucket_name = '' where bucket_name is null;`)
      await queryDb(`update public.drive_project_object_inventory set file_id = encode(gen_random_bytes(12), 'hex') where file_id is null or file_id = '';`)
      await queryDb(`alter table public.drive_project_object_inventory alter column bucket_name set default '';`)
      await queryDb(`alter table public.drive_project_object_inventory alter column bucket_name set not null;`)
      await queryDb(`alter table public.drive_project_object_inventory alter column file_id set default encode(gen_random_bytes(12), 'hex');`)
      await queryDb(`alter table public.drive_project_object_inventory alter column file_id set not null;`)
      await queryDb(`alter table public.drive_project_object_inventory drop constraint if exists drive_project_object_inventory_pkey;`)
      await queryDb(`alter table public.drive_project_object_inventory add constraint drive_project_object_inventory_pkey primary key (project_id, bucket_name, object_key);`)
      await queryDb(`create unique index if not exists drive_project_object_inventory_file_id_key on drive_project_object_inventory (file_id);`)
      await queryDb(`drop index if exists drive_project_object_inventory_search_idx;`)
      await queryDb(`drop index if exists drive_project_object_inventory_updated_idx;`)
      await queryDb(`create index if not exists drive_project_object_inventory_search_idx on drive_project_object_inventory (project_id, bucket_name, object_key text_pattern_ops) where deleted_at is null;`)
      await queryDb(`create index if not exists drive_project_object_inventory_updated_idx on drive_project_object_inventory (project_id, bucket_name, updated_at desc);`)
      await queryDb(`create index if not exists drive_project_object_inventory_project_file_id_idx on drive_project_object_inventory (project_id, file_id) where deleted_at is null;`)

      await queryDb(`
        create table if not exists drive_project_object_locks (
          project_id uuid not null references drive_projects(id) on delete cascade,
          bucket_name text not null,
          object_key text not null,
          lock_token_hash text not null,
          reason text,
          expires_at timestamptz,
          created_at timestamptz not null default now(),
          primary key (project_id, bucket_name, object_key)
        );
      `)
      await queryDb(`alter table public.drive_project_object_locks add column if not exists bucket_name text;`)
      await queryDb(`
        update drive_project_object_locks l
        set bucket_name = coalesce(nullif(p.bucket_name, ''), '')
        from drive_projects p
        where p.id = l.project_id
          and l.bucket_name is null;
      `)
      await queryDb(`update public.drive_project_object_locks set bucket_name = '' where bucket_name is null;`)
      await queryDb(`alter table public.drive_project_object_locks alter column bucket_name set default '';`)
      await queryDb(`alter table public.drive_project_object_locks alter column bucket_name set not null;`)
      await queryDb(`alter table public.drive_project_object_locks drop constraint if exists drive_project_object_locks_pkey;`)
      await queryDb(`alter table public.drive_project_object_locks add constraint drive_project_object_locks_pkey primary key (project_id, bucket_name, object_key);`)

      await queryDb(`
        create table if not exists drive_project_webhooks (
          id uuid primary key default gen_random_uuid(),
          project_id uuid not null references drive_projects(id) on delete cascade,
          target_url text not null,
          events jsonb not null default '[]'::jsonb,
          secret text,
          status text not null default 'active',
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(`
        create table if not exists drive_analytics_bucket_snapshots (
          account_id uuid not null,
          account_label text,
          account_email text,
          bucket_name text not null,
          objects bigint not null default 0,
          bytes bigint not null default 0,
          status text,
          source_updated_at timestamptz,
          captured_at timestamptz not null default now(),
          primary key (account_id, bucket_name)
        );
      `)
      await queryDb(
        `create index if not exists drive_analytics_bucket_snapshots_captured_idx on drive_analytics_bucket_snapshots (captured_at desc);`
      )

      await queryDb(`
        create table if not exists drive_bucket_stat_history (
          id bigint generated always as identity primary key,
          account_id uuid not null,
          account_label text,
          account_email text,
          bucket_name text not null,
          previous_objects bigint,
          objects bigint not null default 0,
          object_delta bigint not null default 0,
          previous_bytes bigint,
          bytes bigint not null default 0,
          byte_delta bigint not null default 0,
          change_type text not null,
          changed_at timestamptz not null default now()
        );
      `)
      await queryDb(`create index if not exists drive_bucket_stat_history_bucket_time_idx on drive_bucket_stat_history (account_id, bucket_name, changed_at desc);`)
      await queryDb(`create index if not exists drive_bucket_stat_history_time_idx on drive_bucket_stat_history (changed_at desc);`)
      await queryDb(`
        create table if not exists drive_maintenance_state (
          task_name text primary key,
          last_run_at timestamptz not null default now(),
          last_result jsonb not null default '{}'::jsonb
        );
      `)
      await queryDb(`
        create table if not exists drive_backend_orchestrator_state (
          id boolean primary key default true check (id),
          status text not null default 'idle',
          orchestrator_url text,
          last_started_at timestamptz,
          last_completed_at timestamptz,
          last_error text,
          last_result jsonb not null default '{}'::jsonb,
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(`
        create table if not exists drive_migrations (
          id uuid primary key,
          source_account_id uuid not null references drive_accounts(id) on delete restrict,
          target_account_id uuid not null references drive_accounts(id) on delete restrict,
          status text not null default 'draft',
          options jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          started_at timestamptz,
          completed_at timestamptz,
          last_synced_at timestamptz,
          sync_status text default 'idle',
          sync_message text,
          summary_item_count integer not null default 0,
          summary_objects bigint not null default 0,
          summary_bytes bigint not null default 0,
          worker_summary jsonb not null default '{}'::jsonb,
          details_compacted_at timestamptz,
          updated_at timestamptz not null default now()
        );
      `)
      await queryDb(`alter table if exists drive_migrations add column if not exists summary_item_count integer not null default 0;`)
      await queryDb(`alter table if exists drive_migrations add column if not exists summary_objects bigint not null default 0;`)
      await queryDb(`alter table if exists drive_migrations add column if not exists summary_bytes bigint not null default 0;`)
      await queryDb(`alter table if exists drive_migrations add column if not exists worker_summary jsonb not null default '{}'::jsonb;`)
      await queryDb(`alter table if exists drive_migrations add column if not exists details_compacted_at timestamptz;`)

      await queryDb(
        `create index if not exists drive_migrations_created_at_idx on drive_migrations (created_at desc);`
      )
      await queryDb(
        `create index if not exists drive_migrations_status_idx on drive_migrations (status);`
      )
      await queryDb(
        `create index if not exists drive_migrations_source_idx on drive_migrations (source_account_id);`
      )
      await queryDb(
        `create index if not exists drive_migrations_target_idx on drive_migrations (target_account_id);`
      )

      await queryDb(`
        create table if not exists drive_migration_items (
          id uuid primary key,
          migration_id uuid not null references drive_migrations(id) on delete cascade,
          source_bucket text not null,
          target_bucket text not null,
          source_jurisdiction text,
          source_storage_class text,
          source_objects bigint,
          source_bytes bigint,
          slurper_job_id text,
          slurper_status text,
          progress jsonb not null default '{}'::jsonb,
          last_progress_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(
        `create unique index if not exists drive_migration_items_unique_bucket on drive_migration_items (migration_id, source_bucket);`
      )
      await queryDb(
        `create index if not exists drive_migration_items_migration_idx on drive_migration_items (migration_id);`
      )
      await queryDb(
        `create index if not exists drive_migration_items_job_idx on drive_migration_items (slurper_job_id);`
      )

      await queryDb(`
        create table if not exists drive_migration_item_failure_records (
          id uuid primary key,
          migration_item_id uuid not null references drive_migration_items(id) on delete cascade,
          object_key text not null,
          message text not null default '',
          occurred_at_text text not null default '',
          occurred_at timestamptz,
          raw_log jsonb,
          source_probe jsonb,
          destination_probe jsonb,
          diagnosis jsonb,
          download jsonb,
          fetched_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(
        `create index if not exists drive_migration_item_failure_records_item_idx on drive_migration_item_failure_records (migration_item_id);`
      )
      await queryDb(
        `create index if not exists drive_migration_item_failure_records_key_idx on drive_migration_item_failure_records (migration_item_id, object_key);`
      )

      await queryDb(`
        create table if not exists drive_agents (
          id uuid primary key,
          name text not null,
          category text not null default 'worker',
          provider text not null default 'self_hosted',
          status text not null default 'pending_registration',
          capabilities jsonb not null default '[]'::jsonb,
          endpoint_domain text,
          endpoint_ip text,
          github_repo_owner text,
          github_repo_name text,
          github_workflow_file text,
          github_ref text,
          github_repository_id text,
          github_token text,
          notes text,
          registration_token text,
          registration_token_hash text,
          last_heartbeat_at timestamptz,
          last_seen_ip text,
          last_seen_host text,
          last_seen_version text,
          last_error text,
          metadata jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(`create index if not exists drive_agents_status_idx on drive_agents (status);`)
      await queryDb(`create index if not exists drive_agents_provider_idx on drive_agents (provider);`)
      await queryDb(`create index if not exists drive_agents_category_idx on drive_agents (category);`)
      await queryDb(`
        update drive_agents
        set github_workflow_file = '.github/workflows/migration-worker.yml', updated_at = now()
        where github_workflow_file = '.github/workflows/agent-worker.yml';
      `)

      await queryDb(`
        create table if not exists drive_agent_runs (
          id uuid primary key,
          agent_id uuid not null references drive_agents(id) on delete cascade,
          run_type text not null default 'manual',
          status text not null default 'pending',
          external_run_id text,
          job_reference text,
          summary text,
          payload jsonb not null default '{}'::jsonb,
          started_at timestamptz,
          completed_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(`create index if not exists drive_agent_runs_agent_idx on drive_agent_runs (agent_id, created_at desc);`)

      await queryDb(`
        create table if not exists drive_repair_jobs (
          id uuid primary key,
          migration_id uuid not null references drive_migrations(id) on delete cascade,
          requested_by_agent_id uuid references drive_agents(id) on delete set null,
          claimed_by_agent_id uuid references drive_agents(id) on delete set null,
          status text not null default 'pending',
          mode text not null default 'repair_and_verify',
          payload jsonb not null default '{}'::jsonb,
          progress jsonb not null default '{}'::jsonb,
          result jsonb not null default '{}'::jsonb,
          summary text,
          error text,
          claimed_at timestamptz,
          started_at timestamptz,
          completed_at timestamptz,
          last_heartbeat_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)

      await queryDb(`create index if not exists drive_repair_jobs_status_idx on drive_repair_jobs (status, created_at);`)
      await queryDb(`create index if not exists drive_repair_jobs_migration_idx on drive_repair_jobs (migration_id, created_at desc);`)
      await queryDb(`create index if not exists drive_repair_jobs_claimed_idx on drive_repair_jobs (claimed_by_agent_id, status);`)

      await queryDb(`
        create table if not exists drive_app_settings (
          key text primary key,
          value jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
      `)
    })()
  }

  return global.__driveEnsureSchema
}
