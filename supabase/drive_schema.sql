-- Run this in Supabase SQL Editor to create the tables used by this app.

create extension if not exists pgcrypto;

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
  password_source text not null default 'local',
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists drive_users_email_key on drive_users (email);
create unique index if not exists drive_users_username_key on drive_users (username) where username is not null;

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

-- Schema updates (idempotent).
-- Note: `create table if not exists` does NOT add missing columns to an existing table.
-- These `alter table ... add column if not exists` statements make the schema forward-compatible.
alter table if exists public.drive_migration_items add column if not exists slurper_job_id text;
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

-- PostgREST caches the schema. If you just added columns, force a reload so the REST API sees them immediately.
select pg_notify('pgrst', 'reload schema');
