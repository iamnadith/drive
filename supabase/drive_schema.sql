-- Run this in Supabase SQL Editor to create the tables used by this app.

create extension if not exists pgcrypto;

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

