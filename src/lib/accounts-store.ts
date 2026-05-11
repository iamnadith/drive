import crypto from "crypto"
import { isPostgresConfigured, queryDb } from "./db"
import { getSupabaseServerClient } from "./supabase"

export type CloudflareAccountStatus = "active" | "disabled" | "available"
export type CloudflareAccountSyncStatus = "idle" | "syncing" | "ok" | "error"

export interface CloudflareAccount {
  id: string
  label: string
  email: string
  password: string
  createdAt: string
  twoFactorSecret?: string
  apiToken: string
  r2AccessKeyId: string
  r2SecretAccessKey: string
  cloudflareAccountId?: string
  cloudflareAccountName?: string
  status: CloudflareAccountStatus
  lastMigrated?: string
  totalBuckets?: number
  totalObjects?: number
  totalBytes?: number
  lastSyncedAt?: string
  syncStatus?: CloudflareAccountSyncStatus
  syncMessage?: string
}

type DriveAccountRow = {
  id: string
  label: string
  email: string
  password: string
  created_at: string
  two_factor_secret: string | null
  api_token: string
  r2_access_key_id: string
  r2_secret_access_key: string
  cloudflare_account_id: string | null
  cloudflare_account_name: string | null
  status: CloudflareAccountStatus
  last_migrated: string | null
  total_buckets: number
  total_objects: number
  total_bytes: number
  last_synced_at: string | null
  sync_status: CloudflareAccountSyncStatus | null
  sync_message: string | null
  updated_at?: string
}

const ACCOUNTS_TABLE = "drive_accounts"
const MIGRATIONS_TABLE = "drive_migrations"

async function archiveAccountBucketStatsBeforeDelete(account: CloudflareAccount): Promise<void> {
  if (!isPostgresConfigured()) return
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
    `
      insert into drive_analytics_bucket_snapshots
        (account_id, account_label, account_email, bucket_name, objects, bytes, status, source_updated_at)
      select account_id, $2, $3, bucket_name, objects, bytes, status, updated_at
      from drive_bucket_stats
      where account_id = $1
      on conflict (account_id, bucket_name) do update set
        account_label = excluded.account_label,
        account_email = excluded.account_email,
        objects = excluded.objects,
        bytes = excluded.bytes,
        status = excluded.status,
        source_updated_at = excluded.source_updated_at,
        captured_at = now();
    `,
    [account.id, account.label, account.email]
  )
}

function normalizeSupabaseError(error: { message: string }): Error {
  const message = String(error?.message ?? "Supabase error")
  if (
    message.includes("Could not find the table") &&
    message.includes(ACCOUNTS_TABLE)
  ) {
    return new Error(
      `Supabase table '${ACCOUNTS_TABLE}' is missing. Create it by running 'supabase/drive_schema.sql' in the Supabase SQL editor for ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "your project"}.`
    )
  }
  if (
    message.includes("violates foreign key constraint") &&
    (message.includes("drive_migrations_source_account_id_fkey") ||
      message.includes("drive_migrations_target_account_id_fkey"))
  ) {
    return new Error(
      "Cannot delete this account because it is referenced by one or more migrations. Delete/archive those migrations first."
    )
  }
  return new Error(message)
}

function mapRow(row: DriveAccountRow): CloudflareAccount {
  return {
    id: row.id,
    label: row.label,
    email: row.email,
    password: row.password,
    createdAt: row.created_at,
    twoFactorSecret: row.two_factor_secret ?? undefined,
    apiToken: row.api_token,
    r2AccessKeyId: row.r2_access_key_id,
    r2SecretAccessKey: row.r2_secret_access_key,
    cloudflareAccountId: row.cloudflare_account_id ?? undefined,
    cloudflareAccountName: row.cloudflare_account_name ?? undefined,
    status: row.status,
    lastMigrated: row.last_migrated ?? undefined,
    totalBuckets: row.total_buckets ?? 0,
    totalObjects: row.total_objects ?? 0,
    totalBytes: row.total_bytes ?? 0,
    lastSyncedAt: row.last_synced_at ?? undefined,
    syncStatus: row.sync_status ?? undefined,
    syncMessage: row.sync_message ?? undefined,
  }
}

export async function getAllAccounts(): Promise<CloudflareAccount[]> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(ACCOUNTS_TABLE)
    .select("*")
    .order("created_at", { ascending: true })

  if (error) throw normalizeSupabaseError(error)
  return (data as DriveAccountRow[]).map(mapRow)
}

export async function getActiveAccount(): Promise<CloudflareAccount | null> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(ACCOUNTS_TABLE)
    .select("*")
    .eq("status", "active")
    .limit(1)

  if (error) throw normalizeSupabaseError(error)
  const row = (data as DriveAccountRow[])[0]
  return row ? mapRow(row) : null
}

export async function createAccount(input: {
  label: string
  email: string
  password: string
  twoFactorSecret?: string
  apiToken: string
  r2AccessKeyId: string
  r2SecretAccessKey: string
  makeActive?: boolean
}): Promise<CloudflareAccount> {
  const supabase = getSupabaseServerClient()

  const normalizedEmail = input.email.trim().toLowerCase()
  const normalizedLabel = input.label.trim()

  const existingEmail = await supabase
    .from(ACCOUNTS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("email", normalizedEmail)
  if (existingEmail.error) throw normalizeSupabaseError(existingEmail.error)
  if ((existingEmail.count ?? 0) > 0) {
    throw new Error("An account with this email already exists")
  }

  const existingLabel = await supabase
    .from(ACCOUNTS_TABLE)
    .select("id", { count: "exact", head: true })
    .ilike("label", normalizedLabel)
  if (existingLabel.error) throw normalizeSupabaseError(existingLabel.error)
  if ((existingLabel.count ?? 0) > 0) {
    throw new Error("An account with this label already exists")
  }

  const existingToken = await supabase
    .from(ACCOUNTS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("api_token", input.apiToken)
  if (existingToken.error) throw normalizeSupabaseError(existingToken.error)
  if ((existingToken.count ?? 0) > 0) {
    throw new Error("An account with this API token already exists")
  }

  if (input.r2AccessKeyId) {
    const existingR2 = await supabase
      .from(ACCOUNTS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("r2_access_key_id", input.r2AccessKeyId)
    if (existingR2.error) throw normalizeSupabaseError(existingR2.error)
    if ((existingR2.count ?? 0) > 0) {
      throw new Error("An account with this R2 access key already exists")
    }
  }

  const accountCountRes = await supabase
    .from(ACCOUNTS_TABLE)
    .select("id", { count: "exact", head: true })
  if (accountCountRes.error) throw normalizeSupabaseError(accountCountRes.error)
  const accountCount = accountCountRes.count ?? 0

  let status: CloudflareAccountStatus = "available"
  if (input.makeActive || accountCount === 0) status = "active"

  let previousActiveIds: string[] = []
  if (status === "active") {
    const { data: activeRows, error: activeRowsError } = await supabase
      .from(ACCOUNTS_TABLE)
      .select("id")
      .eq("status", "active")
    if (activeRowsError) throw normalizeSupabaseError(activeRowsError)
    previousActiveIds = ((activeRows as Array<{ id: string }> | null) ?? []).map((row) => row.id)

    const { error } = await supabase
      .from(ACCOUNTS_TABLE)
      .update({ status: "available" })
      .eq("status", "active")
    if (error) throw normalizeSupabaseError(error)
  }

  const row = {
    id: crypto.randomUUID(),
    label: normalizedLabel,
    email: normalizedEmail,
    password: input.password,
    two_factor_secret: input.twoFactorSecret?.trim() || null,
    api_token: input.apiToken,
    r2_access_key_id: input.r2AccessKeyId,
    r2_secret_access_key: input.r2SecretAccessKey,
    cloudflare_account_id: null,
    cloudflare_account_name: null,
    status,
    last_migrated: "-",
    total_buckets: 0,
    total_objects: 0,
    total_bytes: 0,
    last_synced_at: null,
    sync_status: "idle",
    sync_message: null,
  }

  const { data, error } = await supabase
    .from(ACCOUNTS_TABLE)
    .insert(row)
    .select("*")
    .single()
  if (error) {
    if (status === "active" && previousActiveIds.length > 0) {
      await supabase
        .from(ACCOUNTS_TABLE)
        .update({ status: "active" })
        .in("id", previousActiveIds)
        .catch(() => undefined)
    }
    throw normalizeSupabaseError(error)
  }
  return mapRow(data as DriveAccountRow)
}

export async function updateAccount(
  id: string,
  updates: Partial<
    Pick<
      CloudflareAccount,
      | "label"
      | "email"
      | "password"
      | "createdAt"
      | "twoFactorSecret"
      | "apiToken"
      | "r2AccessKeyId"
      | "r2SecretAccessKey"
      | "cloudflareAccountId"
      | "cloudflareAccountName"
      | "status"
      | "lastMigrated"
      | "totalBuckets"
      | "totalObjects"
      | "totalBytes"
      | "lastSyncedAt"
      | "syncStatus"
      | "syncMessage"
    >
  >
): Promise<CloudflareAccount> {
  const supabase = getSupabaseServerClient()

  const { data: currentRows, error: currentError } = await supabase
    .from(ACCOUNTS_TABLE)
    .select("*")
    .eq("id", id)
    .limit(1)

  if (currentError) throw new Error(currentError.message)
  const current = (currentRows as DriveAccountRow[])[0]
  if (!current) throw new Error("Account not found")

  let previousActiveIds: string[] = []
  if (updates.status === "active") {
    const { data: activeRows, error: activeRowsError } = await supabase
      .from(ACCOUNTS_TABLE)
      .select("id")
      .eq("status", "active")
      .neq("id", id)
    if (activeRowsError) throw normalizeSupabaseError(activeRowsError)
    previousActiveIds = ((activeRows as Array<{ id: string }> | null) ?? []).map((row) => row.id)

    const { error } = await supabase
      .from(ACCOUNTS_TABLE)
      .update({ status: "available" })
      .eq("status", "active")
      .neq("id", id)
    if (error) throw normalizeSupabaseError(error)
  }

  if (
    typeof updates.status !== "undefined" &&
    updates.status !== "active" &&
    current.status === "active"
  ) {
    const remainingCountRes = await supabase
      .from(ACCOUNTS_TABLE)
      .select("id", { count: "exact", head: true })
      .neq("id", id)
    if (remainingCountRes.error) throw new Error(remainingCountRes.error.message)
    const remaining = remainingCountRes.count ?? 0
    if (remaining > 0) {
      const anyActive = await supabase
        .from(ACCOUNTS_TABLE)
        .select("id", { count: "exact", head: true })
        .neq("id", id)
        .eq("status", "active")
      if (anyActive.error) throw new Error(anyActive.error.message)
      if ((anyActive.count ?? 0) === 0) {
        throw new Error("At least one Cloudflare account must remain active")
      }
    }
  }

  const dbUpdates: Record<string, unknown> = {}
  if (updates.label !== undefined) dbUpdates.label = updates.label
  if (updates.email !== undefined) dbUpdates.email = updates.email
  if (updates.password !== undefined) dbUpdates.password = updates.password
  if (updates.createdAt !== undefined) dbUpdates.created_at = updates.createdAt
  if (updates.twoFactorSecret !== undefined)
    dbUpdates.two_factor_secret = updates.twoFactorSecret ?? null
  if (updates.apiToken !== undefined) dbUpdates.api_token = updates.apiToken
  if (updates.r2AccessKeyId !== undefined)
    dbUpdates.r2_access_key_id = updates.r2AccessKeyId
  if (updates.r2SecretAccessKey !== undefined)
    dbUpdates.r2_secret_access_key = updates.r2SecretAccessKey
  if (updates.cloudflareAccountId !== undefined)
    dbUpdates.cloudflare_account_id = updates.cloudflareAccountId ?? null
  if (updates.cloudflareAccountName !== undefined)
    dbUpdates.cloudflare_account_name = updates.cloudflareAccountName ?? null
  if (updates.status !== undefined) dbUpdates.status = updates.status
  if (updates.lastMigrated !== undefined)
    dbUpdates.last_migrated = updates.lastMigrated ?? null
  if (updates.totalBuckets !== undefined) dbUpdates.total_buckets = updates.totalBuckets
  if (updates.totalObjects !== undefined) dbUpdates.total_objects = updates.totalObjects
  if (updates.totalBytes !== undefined) dbUpdates.total_bytes = updates.totalBytes
  if (updates.lastSyncedAt !== undefined)
    dbUpdates.last_synced_at = updates.lastSyncedAt ?? null
  if (updates.syncStatus !== undefined)
    dbUpdates.sync_status = updates.syncStatus ?? null
  if (updates.syncMessage !== undefined)
    dbUpdates.sync_message = updates.syncMessage ?? null

  const { data, error } = await supabase
    .from(ACCOUNTS_TABLE)
    .update(dbUpdates)
    .eq("id", id)
    .select("*")
    .single()

  if (error) {
    if (updates.status === "active" && previousActiveIds.length > 0) {
      await supabase
        .from(ACCOUNTS_TABLE)
        .update({ status: "active" })
        .in("id", previousActiveIds)
        .catch(() => undefined)
    }
    throw normalizeSupabaseError(error)
  }
  return mapRow(data as DriveAccountRow)
}

export async function activateAccountForCompletedMigration(input: {
  targetAccountId: string
  completedAt?: string | null
}): Promise<CloudflareAccount> {
  const targetAccountId = String(input.targetAccountId ?? "").trim()
  if (!targetAccountId) throw new Error("Migration target account is missing")

  const accounts = await getAllAccounts()
  const target = accounts.find((account) => account.id === targetAccountId)
  if (!target) throw new Error("Migration target account not found")

  const completedAt =
    typeof input.completedAt === "string" && input.completedAt.trim().length > 0
      ? input.completedAt
      : new Date().toISOString()

  if (target.status === "active") {
    return updateAccount(target.id, {
      lastMigrated: completedAt,
    })
  }

  try {
    return await updateAccount(target.id, {
      status: "active",
      lastMigrated: completedAt,
    })
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "")

    if (!message.includes("drive_accounts_one_active_key")) throw error

    const refreshed = await getAllAccounts()
    const activeTarget = refreshed.find((account) => account.id === targetAccountId && account.status === "active")
    if (!activeTarget) throw error

    return updateAccount(activeTarget.id, {
      lastMigrated: completedAt,
    })
  }
}

export async function deleteAccount(id: string): Promise<void> {
  const supabase = getSupabaseServerClient()

  const { data: targetRows, error: targetError } = await supabase
    .from(ACCOUNTS_TABLE)
    .select("*")
    .eq("id", id)
    .limit(1)

  if (targetError) throw new Error(targetError.message)
  const targetRow = (targetRows as DriveAccountRow[])[0]
  const target = targetRow ? mapRow(targetRow) : null
  if (!target) return

  if (target.status === "active") {
    const remainingRes = await supabase
      .from(ACCOUNTS_TABLE)
      .select("id", { count: "exact", head: true })
      .neq("id", id)
    if (remainingRes.error) throw new Error(remainingRes.error.message)
    const remaining = remainingRes.count ?? 0
    if (remaining > 0) {
      const anyActive = await supabase
        .from(ACCOUNTS_TABLE)
        .select("id", { count: "exact", head: true })
        .neq("id", id)
        .eq("status", "active")
      if (anyActive.error) throw new Error(anyActive.error.message)
      if ((anyActive.count ?? 0) === 0) {
        throw new Error("Cannot delete the last active Cloudflare account")
      }
    }
  }

  const sourceRefs = await supabase
    .from(MIGRATIONS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("source_account_id", id)
  if (sourceRefs.error) throw normalizeSupabaseError(sourceRefs.error)

  const targetRefs = await supabase
    .from(MIGRATIONS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("target_account_id", id)
  if (targetRefs.error) throw normalizeSupabaseError(targetRefs.error)

  if ((sourceRefs.count ?? 0) > 0 || (targetRefs.count ?? 0) > 0) {
    throw new Error(
      "Cannot delete this account because it is referenced by one or more migrations. Delete/archive those migrations first."
    )
  }

  await archiveAccountBucketStatsBeforeDelete(target).catch(() => undefined)

  const { error } = await supabase.from(ACCOUNTS_TABLE).delete().eq("id", id)
  if (error) throw normalizeSupabaseError(error)
}
