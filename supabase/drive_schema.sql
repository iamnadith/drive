-- Run this in Supabase SQL Editor to create the tables used by this app.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- Ensure we operate on the expected schema in Supabase (usually `public`).
set search_path = public;

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
  mobile_number text,
  mobile_verified boolean not null default false,
  mobile_verified_at timestamptz,
  password_source text not null default 'local',
  two_factor_enabled boolean not null default false,
  totp_enabled boolean not null default false,
  totp_secret text,
  totp_last_used_counter bigint,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists drive_users_email_key on drive_users (email);
create unique index if not exists drive_users_username_key on drive_users (username) where username is not null;

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

create table if not exists drive_sms_verification_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references drive_users(id) on delete cascade,
  token_hash text not null,
  mobile_number text not null,
  purpose text not null default 'login',
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists drive_sms_verification_tokens_hash_idx
  on drive_sms_verification_tokens (token_hash);
create index if not exists drive_sms_verification_tokens_user_idx
  on drive_sms_verification_tokens (user_id, purpose, created_at desc);
create index if not exists drive_sms_verification_tokens_expires_idx
  on drive_sms_verification_tokens (expires_at);
create index if not exists drive_sms_verification_tokens_mobile_purpose_idx
  on drive_sms_verification_tokens (mobile_number, purpose, created_at desc);

drop index if exists drive_email_verification_tokens_hash_key;
create index if not exists drive_email_verification_tokens_hash_idx
  on drive_email_verification_tokens (token_hash);
create index if not exists drive_email_verification_tokens_user_idx
  on drive_email_verification_tokens (user_id, purpose, created_at desc);
create index if not exists drive_email_verification_tokens_expires_idx
  on drive_email_verification_tokens (expires_at);
create index if not exists drive_email_verification_tokens_email_purpose_idx
  on drive_email_verification_tokens (email, purpose, created_at desc);

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

create unique index if not exists drive_accounts_email_key on drive_accounts (email);
create unique index if not exists drive_accounts_api_token_key on drive_accounts (api_token);
create unique index if not exists drive_accounts_r2_access_key_id_key on drive_accounts (r2_access_key_id);
create unique index if not exists drive_accounts_label_ci_key on drive_accounts ((lower(label)));

-- At most one account can be active at a time.
create unique index if not exists drive_accounts_one_active_key
  on drive_accounts ((status))
  where status = 'active';

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

create unique index if not exists drive_bucket_stats_unique on drive_bucket_stats (account_id, bucket_name);
create index if not exists drive_bucket_stats_account_idx on drive_bucket_stats (account_id);
create index if not exists drive_bucket_stats_status_idx on drive_bucket_stats (status);

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

-- Older installs may have created drive_projects.id as text. The current
-- schema uses uuid IDs because child tables reference drive_projects(id).
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

-- `create table if not exists` does not add columns to an existing table.
-- Repair older installs that had `drive_projects` before project API support.
alter table if exists public.drive_projects add column if not exists project_id text;
alter table if exists public.drive_projects add column if not exists name text;
alter table if exists public.drive_projects add column if not exists bucket_name text;
alter table if exists public.drive_projects add column if not exists status text not null default 'active';
alter table if exists public.drive_projects add column if not exists created_account_id uuid references public.drive_accounts(id) on delete set null;
alter table if exists public.drive_projects add column if not exists created_account_label text;
alter table if exists public.drive_projects add column if not exists created_at timestamptz not null default now();
alter table if exists public.drive_projects add column if not exists updated_at timestamptz not null default now();

update public.drive_projects
set project_id = 'prj_' || replace(id::text, '-', '')
where project_id is null;

update public.drive_projects
set name = coalesce(nullif(bucket_name, ''), 'Imported project')
where name is null;

update public.drive_projects
set bucket_name = project_id
where bucket_name is null;

alter table if exists public.drive_projects alter column project_id set not null;
alter table if exists public.drive_projects alter column name set not null;
alter table if exists public.drive_projects alter column bucket_name set not null;

create unique index if not exists drive_projects_project_id_key on drive_projects (project_id);
create unique index if not exists drive_projects_bucket_name_key on drive_projects (bucket_name);
create index if not exists drive_projects_status_idx on drive_projects (status);

-- A bucket belongs to at most one project.
create table if not exists drive_project_bucket_assignments (
  project_id uuid not null references drive_projects(id) on delete cascade,
  bucket_name text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (project_id, bucket_name)
);

alter table if exists public.drive_project_bucket_assignments
  drop column if exists media_allowed_origins;
alter table if exists public.drive_project_bucket_assignments
  drop column if exists public_access_enabled;

create unique index if not exists drive_project_bucket_assignments_bucket_key
  on drive_project_bucket_assignments (bucket_name);
create unique index if not exists drive_project_bucket_assignments_primary_idx
  on drive_project_bucket_assignments (project_id) where is_primary = true;

-- Drive delivery authorization is intentionally independent of Cloudflare's
-- public development URL. Existing buckets default to Drive delivery enabled.
-- NULL media_allowed_origins retains the legacy deployment-level allowlist;
-- an empty array explicitly denies cross-origin media reads.
create table if not exists drive_bucket_delivery_settings (
  account_id uuid not null references drive_accounts(id) on delete cascade,
  bucket_name text not null,
  public_access_enabled boolean not null default true,
  media_allowed_origins text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, bucket_name)
);

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

create unique index if not exists drive_project_api_keys_hash_key
  on drive_project_api_keys (key_hash);
create index if not exists drive_project_api_keys_status_idx
  on drive_project_api_keys (status);

create table if not exists drive_project_api_key_assignments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references drive_projects(id) on delete cascade,
  api_key_id uuid not null references drive_project_api_keys(id) on delete cascade,
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.drive_project_api_key_assignments add column if not exists project_id uuid references public.drive_projects(id) on delete cascade;
alter table if exists public.drive_project_api_key_assignments add column if not exists api_key_id uuid references public.drive_project_api_keys(id) on delete cascade;
alter table if exists public.drive_project_api_key_assignments add column if not exists permissions jsonb not null default '{}'::jsonb;
alter table if exists public.drive_project_api_key_assignments add column if not exists created_at timestamptz not null default now();
alter table if exists public.drive_project_api_key_assignments add column if not exists updated_at timestamptz not null default now();

create unique index if not exists drive_project_api_key_assignments_unique
  on drive_project_api_key_assignments (project_id, api_key_id);
create index if not exists drive_project_api_key_assignments_key_idx
  on drive_project_api_key_assignments (api_key_id);

create table if not exists drive_project_file_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references drive_projects(id) on delete cascade,
  object_key text not null,
  token_hash text not null,
  mode text not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table if exists public.drive_project_file_links add column if not exists project_id uuid references public.drive_projects(id) on delete cascade;
alter table if exists public.drive_project_file_links add column if not exists object_key text;
alter table if exists public.drive_project_file_links add column if not exists token_hash text;
alter table if exists public.drive_project_file_links add column if not exists mode text;
alter table if exists public.drive_project_file_links add column if not exists expires_at timestamptz;
alter table if exists public.drive_project_file_links add column if not exists revoked_at timestamptz;
alter table if exists public.drive_project_file_links add column if not exists created_at timestamptz not null default now();

create unique index if not exists drive_project_file_links_token_hash_key
  on drive_project_file_links (token_hash);
create index if not exists drive_project_file_links_project_idx
  on drive_project_file_links (project_id, object_key);
create index if not exists drive_project_file_links_active_idx
  on drive_project_file_links (mode, revoked_at, expires_at);

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

alter table if exists public.drive_project_operation_jobs add column if not exists project_id uuid references public.drive_projects(id) on delete cascade;
alter table if exists public.drive_project_operation_jobs add column if not exists type text;
alter table if exists public.drive_project_operation_jobs add column if not exists status text not null default 'queued';
alter table if exists public.drive_project_operation_jobs add column if not exists payload jsonb not null default '{}'::jsonb;
alter table if exists public.drive_project_operation_jobs add column if not exists progress jsonb not null default '{}'::jsonb;
alter table if exists public.drive_project_operation_jobs add column if not exists result jsonb not null default '{}'::jsonb;
alter table if exists public.drive_project_operation_jobs add column if not exists error text;
alter table if exists public.drive_project_operation_jobs add column if not exists idempotency_key text;
alter table if exists public.drive_project_operation_jobs add column if not exists created_at timestamptz not null default now();
alter table if exists public.drive_project_operation_jobs add column if not exists updated_at timestamptz not null default now();
alter table if exists public.drive_project_operation_jobs add column if not exists started_at timestamptz;
alter table if exists public.drive_project_operation_jobs add column if not exists completed_at timestamptz;

create index if not exists drive_project_operation_jobs_project_idx
  on drive_project_operation_jobs (project_id, created_at desc);
create index if not exists drive_project_operation_jobs_status_idx
  on drive_project_operation_jobs (status, created_at);
create unique index if not exists drive_project_operation_jobs_idempotency_key
  on drive_project_operation_jobs (project_id, idempotency_key)
  where idempotency_key is not null;

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

alter table if exists public.drive_project_api_events add column if not exists occurred_at timestamptz not null default now();
alter table if exists public.drive_project_api_events add column if not exists project_id uuid references public.drive_projects(id) on delete cascade;
alter table if exists public.drive_project_api_events add column if not exists api_key_id uuid references public.drive_project_api_keys(id) on delete set null;
alter table if exists public.drive_project_api_events add column if not exists action text not null default 'unknown';
alter table if exists public.drive_project_api_events add column if not exists object_key text;
alter table if exists public.drive_project_api_events add column if not exists status integer;
alter table if exists public.drive_project_api_events add column if not exists outcome text not null default 'success';
alter table if exists public.drive_project_api_events add column if not exists ip_address text;
alter table if exists public.drive_project_api_events add column if not exists user_agent text;
alter table if exists public.drive_project_api_events add column if not exists request_id text;
alter table if exists public.drive_project_api_events add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists drive_project_api_events_project_time_idx
  on drive_project_api_events (project_id, occurred_at desc);
create index if not exists drive_project_api_events_key_time_idx
  on drive_project_api_events (api_key_id, occurred_at desc);
create index if not exists drive_project_api_events_action_time_idx
  on drive_project_api_events (action, occurred_at desc);

create table if not exists drive_project_object_inventory (
  project_id uuid not null references drive_projects(id) on delete cascade,
  object_key text not null,
  size bigint not null default 0,
  etag text,
  content_type text,
  metadata jsonb not null default '{}'::jsonb,
  last_modified timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (project_id, object_key)
);

alter table if exists public.drive_project_object_inventory add column if not exists project_id uuid references public.drive_projects(id) on delete cascade;
alter table if exists public.drive_project_object_inventory add column if not exists object_key text;
alter table if exists public.drive_project_object_inventory add column if not exists size bigint not null default 0;
alter table if exists public.drive_project_object_inventory add column if not exists etag text;
alter table if exists public.drive_project_object_inventory add column if not exists content_type text;
alter table if exists public.drive_project_object_inventory add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table if exists public.drive_project_object_inventory add column if not exists last_modified timestamptz;
alter table if exists public.drive_project_object_inventory add column if not exists deleted_at timestamptz;
alter table if exists public.drive_project_object_inventory add column if not exists updated_at timestamptz not null default now();

create index if not exists drive_project_object_inventory_search_idx
  on drive_project_object_inventory (project_id, object_key text_pattern_ops)
  where deleted_at is null;
create index if not exists drive_project_object_inventory_updated_idx
  on drive_project_object_inventory (project_id, updated_at desc);

create table if not exists drive_project_object_locks (
  project_id uuid not null references drive_projects(id) on delete cascade,
  object_key text not null,
  lock_token_hash text not null,
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (project_id, object_key)
);

alter table if exists public.drive_project_object_locks add column if not exists project_id uuid references public.drive_projects(id) on delete cascade;
alter table if exists public.drive_project_object_locks add column if not exists object_key text;
alter table if exists public.drive_project_object_locks add column if not exists lock_token_hash text;
alter table if exists public.drive_project_object_locks add column if not exists reason text;
alter table if exists public.drive_project_object_locks add column if not exists expires_at timestamptz;
alter table if exists public.drive_project_object_locks add column if not exists created_at timestamptz not null default now();

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

alter table if exists public.drive_project_webhooks add column if not exists project_id uuid references public.drive_projects(id) on delete cascade;
alter table if exists public.drive_project_webhooks add column if not exists target_url text;
alter table if exists public.drive_project_webhooks add column if not exists events jsonb not null default '[]'::jsonb;
alter table if exists public.drive_project_webhooks add column if not exists secret text;
alter table if exists public.drive_project_webhooks add column if not exists status text not null default 'active';
alter table if exists public.drive_project_webhooks add column if not exists created_at timestamptz not null default now();
alter table if exists public.drive_project_webhooks add column if not exists updated_at timestamptz not null default now();

-- Analytics archive for preserving bucket/account totals after an account is deleted.
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

create index if not exists drive_analytics_bucket_snapshots_captured_idx
  on drive_analytics_bucket_snapshots (captured_at desc);

-- Daily history of whichever account was active when analytics were refreshed.
-- This lets overview charts span current and previous active accounts without
-- summing every stored account at the same time.
create table if not exists drive_analytics_active_account_snapshots (
  captured_day date not null,
  account_id uuid not null,
  account_label text,
  account_email text,
  buckets integer not null default 0,
  objects bigint not null default 0,
  bytes bigint not null default 0,
  captured_at timestamptz not null default now(),
  primary key (captured_day, account_id)
);

create index if not exists drive_analytics_active_account_snapshots_day_idx
  on drive_analytics_active_account_snapshots (captured_day desc);

-- Logical object history. A completed scan generation atomically replaces the
-- current inventory, so migrated copies are not summed across accounts.
create table if not exists drive_object_sync_runs (
  id uuid primary key,
  account_id uuid not null references drive_accounts(id) on delete cascade,
  status text not null default 'running',
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists drive_object_sync_runs_active_idx on drive_object_sync_runs (account_id, status, started_at desc);

create table if not exists drive_object_sync_objects (
  run_id uuid not null references drive_object_sync_runs(id) on delete cascade,
  bucket_name text not null,
  key text not null,
  size bigint not null default 0,
  etag text,
  last_modified timestamptz,
  primary key (run_id, bucket_name, key)
);

create table if not exists drive_logical_object_inventory (
  bucket_name text not null,
  key text not null,
  account_id uuid not null references drive_accounts(id) on delete cascade,
  size bigint not null default 0,
  etag text,
  last_modified timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (bucket_name, key)
);

create table if not exists drive_object_change_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references drive_object_sync_runs(id) on delete set null,
  occurred_at timestamptz not null default now(),
  change_type text not null,
  bucket_name text not null,
  key text not null,
  previous_size bigint,
  current_size bigint,
  account_id uuid references drive_accounts(id) on delete set null
);
create index if not exists drive_object_change_events_time_idx on drive_object_change_events (occurred_at desc);

create table if not exists drive_logical_storage_snapshots (
  captured_day date primary key,
  captured_at timestamptz not null default now(),
  account_id uuid references drive_accounts(id) on delete set null,
  buckets integer not null default 0,
  objects bigint not null default 0,
  bytes bigint not null default 0,
  added bigint not null default 0,
  updated bigint not null default 0,
  deleted bigint not null default 0
);

create table if not exists drive_migrations (
  id uuid primary key,
  source_account_id uuid not null references drive_accounts(id) on delete restrict,
  target_account_id uuid not null references drive_accounts(id) on delete restrict,
  -- status values used by the app: draft | running | verifying | completed | failed | canceled
  status text not null default 'draft',
  options jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_synced_at timestamptz,
  sync_status text default 'idle',
  sync_message text,
  updated_at timestamptz not null default now()
);

create index if not exists drive_migrations_created_at_idx on drive_migrations (created_at desc);
create index if not exists drive_migrations_status_idx on drive_migrations (status);
create index if not exists drive_migrations_source_idx on drive_migrations (source_account_id);
create index if not exists drive_migrations_target_idx on drive_migrations (target_account_id);

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

create unique index if not exists drive_migration_items_unique_bucket
  on drive_migration_items (migration_id, source_bucket);

create index if not exists drive_migration_items_migration_idx on drive_migration_items (migration_id);
create index if not exists drive_migration_items_job_idx on drive_migration_items (slurper_job_id);

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

create index if not exists drive_migration_item_failure_records_item_idx
  on drive_migration_item_failure_records (migration_item_id);
create index if not exists drive_migration_item_failure_records_key_idx
  on drive_migration_item_failure_records (migration_item_id, object_key);

-- Bucket object inventories (for accurate counts and post-migration verification).
create table if not exists drive_bucket_scans (
  id uuid primary key,
  account_id uuid not null references drive_accounts(id) on delete cascade,
  bucket_name text not null,
  kind text not null default 'source', -- source | dest
  migration_id uuid references drive_migrations(id) on delete cascade,
  migration_item_id uuid references drive_migration_items(id) on delete cascade,
  prefix text,
  status text not null default 'pending', -- pending | running | completed | failed
  last_key text,
  objects bigint not null default 0,
  bytes bigint not null default 0,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists drive_bucket_scans_account_bucket_idx on drive_bucket_scans (account_id, bucket_name);
create index if not exists drive_bucket_scans_migration_idx on drive_bucket_scans (migration_id);
create index if not exists drive_bucket_scans_item_idx on drive_bucket_scans (migration_item_id);
create index if not exists drive_bucket_scans_status_idx on drive_bucket_scans (status);

create table if not exists drive_bucket_scan_objects (
  scan_id uuid not null references drive_bucket_scans(id) on delete cascade,
  key text not null,
  size bigint not null default 0,
  is_dir_marker boolean not null default false,
  etag text,
  last_modified timestamptz,
  created_at timestamptz not null default now(),
  primary key (scan_id, key)
);

create index if not exists drive_bucket_scan_objects_key_idx on drive_bucket_scan_objects (scan_id, key);

create table if not exists drive_bucket_verify_diffs (
  id uuid primary key,
  migration_item_id uuid not null references drive_migration_items(id) on delete cascade,
  source_scan_id uuid not null references drive_bucket_scans(id) on delete cascade,
  dest_scan_id uuid not null references drive_bucket_scans(id) on delete cascade,
  kind text not null, -- missing | size_mismatch | extra
  key text not null,
  source_size bigint,
  dest_size bigint,
  created_at timestamptz not null default now()
);

create index if not exists drive_bucket_verify_diffs_item_idx on drive_bucket_verify_diffs (migration_item_id);
create index if not exists drive_bucket_verify_diffs_kind_idx on drive_bucket_verify_diffs (kind);

create table if not exists drive_agents (
  id uuid primary key,
  name text not null,
  category text not null default 'worker', -- worker | agent
  provider text not null default 'self_hosted', -- self_hosted | github_actions | local
  status text not null default 'pending_registration', -- pending_registration | online | offline | busy | dispatch_ready | disabled | error
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

create index if not exists drive_agents_status_idx on drive_agents (status);
create index if not exists drive_agents_provider_idx on drive_agents (provider);
create index if not exists drive_agents_category_idx on drive_agents (category);

create table if not exists drive_agent_runs (
  id uuid primary key,
  agent_id uuid not null references drive_agents(id) on delete cascade,
  run_type text not null default 'manual',
  status text not null default 'pending', -- pending | running | completed | failed | canceled
  external_run_id text,
  job_reference text,
  summary text,
  payload jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists drive_agent_runs_agent_idx on drive_agent_runs (agent_id, created_at desc);

create table if not exists drive_repair_jobs (
  id uuid primary key,
  migration_id uuid not null references drive_migrations(id) on delete cascade,
  requested_by_agent_id uuid references drive_agents(id) on delete set null,
  claimed_by_agent_id uuid references drive_agents(id) on delete set null,
  status text not null default 'pending', -- pending | claimed | running | completed | failed | canceled
  mode text not null default 'repair_and_verify', -- verify_only | repair_only | repair_and_verify
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

create index if not exists drive_repair_jobs_status_idx on drive_repair_jobs (status, created_at);
create index if not exists drive_repair_jobs_migration_idx on drive_repair_jobs (migration_id, created_at desc);
create index if not exists drive_repair_jobs_claimed_idx on drive_repair_jobs (claimed_by_agent_id, status);

-- Append-only audit/activity log. This table is designed for large volumes:
-- use keyset pagination on (occurred_at, id), narrow indexed filters, and
-- trigram search over a compact generated search_text column.
create table if not exists drive_activity_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  actor_user_id uuid references drive_users(id) on delete set null,
  actor_name text,
  actor_email text,
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id text,
  entity_label text,
  summary text not null,
  detail text,
  outcome text not null default 'success',
  ip_address text,
  user_agent text,
  request_id text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb not null default '{}'::jsonb,
  search_text text not null default '',
  undoable boolean not null default false,
  undo_status text not null default 'not_undoable',
  undo_reason text,
  undo_payload jsonb,
  undone_at timestamptz,
  undone_by_user_id uuid references drive_users(id) on delete set null
);

create index if not exists drive_activity_events_time_idx
  on drive_activity_events (occurred_at desc, id desc);
create index if not exists drive_activity_events_actor_time_idx
  on drive_activity_events (actor_user_id, occurred_at desc, id desc);
create index if not exists drive_activity_events_action_time_idx
  on drive_activity_events (action, occurred_at desc, id desc);
create index if not exists drive_activity_events_entity_time_idx
  on drive_activity_events (entity_type, entity_id, occurred_at desc, id desc);
create index if not exists drive_activity_events_outcome_time_idx
  on drive_activity_events (outcome, occurred_at desc, id desc);
create index if not exists drive_activity_events_undo_time_idx
  on drive_activity_events (undoable, undo_status, occurred_at desc, id desc);
create index if not exists drive_activity_events_search_trgm_idx
  on drive_activity_events using gin (search_text gin_trgm_ops);

-- Schema updates (idempotent).
-- Note: `create table if not exists` does NOT add missing columns to an existing table.
-- These `alter table ... add column if not exists` statements make the schema forward-compatible.
alter table if exists public.drive_migration_items add column if not exists slurper_job_id text;
alter table if exists public.drive_users add column if not exists email_verified boolean not null default true;
alter table if exists public.drive_users add column if not exists email_verified_at timestamptz;
alter table if exists public.drive_users add column if not exists mobile_number text;
alter table if exists public.drive_users add column if not exists mobile_verified boolean not null default false;
alter table if exists public.drive_users add column if not exists mobile_verified_at timestamptz;
alter table if exists public.drive_users add column if not exists two_factor_enabled boolean not null default false;
alter table if exists public.drive_users add column if not exists totp_enabled boolean not null default false;
alter table if exists public.drive_users add column if not exists totp_secret text;
alter table if exists public.drive_users add column if not exists totp_last_used_counter bigint;
alter table if exists public.drive_email_verification_tokens add column if not exists purpose text not null default 'signup';
alter table if exists public.drive_email_verification_tokens add column if not exists attempts integer not null default 0;
alter table if exists public.drive_migration_items add column if not exists slurper_status text;
alter table if exists public.drive_migration_items add column if not exists progress jsonb not null default '{}'::jsonb;
alter table if exists public.drive_migration_items add column if not exists last_progress_at timestamptz;

alter table if exists public.drive_bucket_scans add column if not exists migration_id uuid references public.drive_migrations(id) on delete cascade;
alter table if exists public.drive_bucket_scans add column if not exists migration_item_id uuid references public.drive_migration_items(id) on delete cascade;
alter table if exists public.drive_bucket_scan_objects add column if not exists is_dir_marker boolean not null default false;
alter table if exists public.drive_agents add column if not exists category text not null default 'worker';
alter table if exists public.drive_agents add column if not exists provider text not null default 'self_hosted';
alter table if exists public.drive_agents add column if not exists status text not null default 'pending_registration';
alter table if exists public.drive_agents add column if not exists capabilities jsonb not null default '[]'::jsonb;
alter table if exists public.drive_agents add column if not exists endpoint_domain text;
alter table if exists public.drive_agents add column if not exists endpoint_ip text;
alter table if exists public.drive_agents add column if not exists github_repo_owner text;
alter table if exists public.drive_agents add column if not exists github_repo_name text;
alter table if exists public.drive_agents add column if not exists github_workflow_file text;
alter table if exists public.drive_agents add column if not exists github_ref text;
alter table if exists public.drive_agents add column if not exists github_repository_id text;
alter table if exists public.drive_agents add column if not exists github_token text;
alter table if exists public.drive_agents add column if not exists notes text;
alter table if exists public.drive_agents add column if not exists registration_token text;
alter table if exists public.drive_agents add column if not exists registration_token_hash text;
alter table if exists public.drive_agents add column if not exists last_heartbeat_at timestamptz;
alter table if exists public.drive_agents add column if not exists last_seen_ip text;
alter table if exists public.drive_agents add column if not exists last_seen_host text;
alter table if exists public.drive_agents add column if not exists last_seen_version text;
alter table if exists public.drive_agents add column if not exists last_error text;
alter table if exists public.drive_agents add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table if exists public.drive_repair_jobs add column if not exists requested_by_agent_id uuid references public.drive_agents(id) on delete set null;
alter table if exists public.drive_repair_jobs add column if not exists claimed_by_agent_id uuid references public.drive_agents(id) on delete set null;
alter table if exists public.drive_repair_jobs add column if not exists status text not null default 'pending';
alter table if exists public.drive_repair_jobs add column if not exists mode text not null default 'repair_and_verify';
alter table if exists public.drive_repair_jobs add column if not exists payload jsonb not null default '{}'::jsonb;
alter table if exists public.drive_repair_jobs add column if not exists progress jsonb not null default '{}'::jsonb;
alter table if exists public.drive_repair_jobs add column if not exists result jsonb not null default '{}'::jsonb;
alter table if exists public.drive_repair_jobs add column if not exists summary text;
alter table if exists public.drive_repair_jobs add column if not exists error text;
alter table if exists public.drive_repair_jobs add column if not exists claimed_at timestamptz;
alter table if exists public.drive_repair_jobs add column if not exists started_at timestamptz;
alter table if exists public.drive_repair_jobs add column if not exists completed_at timestamptz;
alter table if exists public.drive_repair_jobs add column if not exists last_heartbeat_at timestamptz;
alter table if exists public.drive_activity_events add column if not exists actor_user_id uuid references public.drive_users(id) on delete set null;
alter table if exists public.drive_activity_events add column if not exists actor_name text;
alter table if exists public.drive_activity_events add column if not exists actor_email text;
alter table if exists public.drive_activity_events add column if not exists actor_role text;
alter table if exists public.drive_activity_events add column if not exists entity_label text;
alter table if exists public.drive_activity_events add column if not exists ip_address text;
alter table if exists public.drive_activity_events add column if not exists user_agent text;
alter table if exists public.drive_activity_events add column if not exists request_id text;
alter table if exists public.drive_activity_events add column if not exists before_state jsonb;
alter table if exists public.drive_activity_events add column if not exists after_state jsonb;
alter table if exists public.drive_activity_events add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table if exists public.drive_activity_events add column if not exists search_text text not null default '';
alter table if exists public.drive_activity_events add column if not exists undoable boolean not null default false;
alter table if exists public.drive_activity_events add column if not exists undo_status text not null default 'not_undoable';
alter table if exists public.drive_activity_events add column if not exists undo_reason text;
alter table if exists public.drive_activity_events add column if not exists undo_payload jsonb;
alter table if exists public.drive_activity_events add column if not exists undone_at timestamptz;
alter table if exists public.drive_activity_events add column if not exists undone_by_user_id uuid references public.drive_users(id) on delete set null;
