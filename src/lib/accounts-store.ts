import crypto from "crypto"
import { queryDb, withDbTransaction } from "./db"

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
  total_buckets: number | string
  total_objects: number | string
  total_bytes: number | string
  last_synced_at: string | null
  sync_status: CloudflareAccountSyncStatus | null
  sync_message: string | null
  updated_at: string | null
}

const ACCOUNTS_TABLE = "drive_accounts"
const MIGRATIONS_TABLE = "drive_migrations"

function mapRow(row: DriveAccountRow): CloudflareAccount {
  const numeric = (value: number | string) => {
    const parsed = typeof value === "number" ? value : Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
  }
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
    totalBuckets: numeric(row.total_buckets),
    totalObjects: numeric(row.total_objects),
    totalBytes: numeric(row.total_bytes),
    lastSyncedAt: row.last_synced_at ?? undefined,
    syncStatus: row.sync_status ?? undefined,
    syncMessage: row.sync_message ?? undefined,
  }
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value || value === "-") return Number.NaN
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function compareRowsByRecency(a: DriveAccountRow, b: DriveAccountRow): number {
  const fields: Array<keyof DriveAccountRow> = ["last_migrated", "updated_at", "created_at"]
  for (const field of fields) {
    const diff = parseTimestamp(b[field] as string | null | undefined) - parseTimestamp(a[field] as string | null | undefined)
    if (Number.isFinite(diff) && diff !== 0) return diff
  }
  return (b.created_at || "").localeCompare(a.created_at || "")
}

async function readAllAccountRows(): Promise<DriveAccountRow[]> {
  const { rows } = await queryDb<DriveAccountRow>(
    `select * from public.${ACCOUNTS_TABLE} order by created_at asc, id asc`
  )
  return rows
}

async function reconcileAccountStatuses(
  options?: {
    preferredActiveAccountId?: string
    promoteFirstAvailable?: boolean
  }
): Promise<DriveAccountRow[]> {
  return withDbTransaction(async (client) => {
  await client.query(`select pg_advisory_xact_lock(hashtext('drive_accounts'), hashtext('active-status'))`)
  let rows = (await client.query<DriveAccountRow>(`select * from public.${ACCOUNTS_TABLE} order by created_at asc, id asc for update`)).rows
  const preferredId = typeof options?.preferredActiveAccountId === "string" ? options.preferredActiveAccountId.trim() : ""
  const preferred = preferredId ? rows.find((row) => row.id === preferredId) ?? null : null

  let desiredActiveId = ""
  if (preferred && preferred.status !== "disabled") {
    desiredActiveId = preferred.id
  } else {
    const activeRows = rows.filter((row) => row.status === "active").sort(compareRowsByRecency)
    if (activeRows.length > 0) {
      desiredActiveId = activeRows[0].id
    } else if (options?.promoteFirstAvailable) {
      desiredActiveId = rows.find((row) => row.status === "available")?.id ?? ""
    }
  }

  const activeIdsToDemote = rows
    .filter((row) => row.status === "active" && row.id !== desiredActiveId)
    .map((row) => row.id)

  let changed = false
  if (activeIdsToDemote.length > 0) {
    const result = await client.query(
      `update public.${ACCOUNTS_TABLE} set status='disabled',updated_at=now() where id=any($1::uuid[]) and status='active'`,
      [activeIdsToDemote]
    )
    changed ||= (result.rowCount ?? 0) > 0
  }

  if (desiredActiveId) {
    const desired = rows.find((row) => row.id === desiredActiveId) ?? null
    if (desired && desired.status !== "active") {
      const canPromote = desired.status === "available"
      if (canPromote) {
        const result = await client.query(
          `update public.${ACCOUNTS_TABLE} set status='active',updated_at=now() where id=$1 and status='available'`,
          [desiredActiveId]
        )
        changed ||= (result.rowCount ?? 0) > 0
      }
    }
  }

  if (changed) {
    rows = (await client.query<DriveAccountRow>(`select * from public.${ACCOUNTS_TABLE} order by created_at asc, id asc`)).rows
  }

  return rows
  })
}

export async function getAllAccounts(): Promise<CloudflareAccount[]> {
  const rows = await readAllAccountRows()
  return rows.map(mapRow)
}

export async function getAccountById(accountId: string): Promise<CloudflareAccount | null> {
  const { rows } = await queryDb<DriveAccountRow>(
    `select * from public.${ACCOUNTS_TABLE} where id=$1 limit 1`,
    [accountId]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getActiveAccount(): Promise<CloudflareAccount | null> {
  const { rows } = await queryDb<DriveAccountRow>(`
    select * from public.${ACCOUNTS_TABLE}
    where status='active'
    order by updated_at desc nulls last, created_at desc, id desc
    limit 1
  `)
  const row = rows[0]
  return row ? mapRow(row) : null
}

export async function getActiveAccountId(): Promise<string | null> {
  const { rows } = await queryDb<{ id: string }>(`
    select id from public.${ACCOUNTS_TABLE}
    where status='active'
    order by updated_at desc nulls last, created_at desc, id desc
    limit 1
  `)
  return rows[0]?.id ?? null
}

export async function getActiveAccountR2Credentials() {
  const { rows } = await queryDb<Pick<DriveAccountRow,
    "id" | "status" | "cloudflare_account_id" | "r2_access_key_id" | "r2_secret_access_key"
  >>(`
    select id,status,cloudflare_account_id,r2_access_key_id,r2_secret_access_key
    from public.${ACCOUNTS_TABLE}
    where status='active'
    order by updated_at desc nulls last,created_at desc,id desc
    limit 1
  `)
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    cloudflareAccountId: row.cloudflare_account_id ?? undefined,
    r2AccessKeyId: row.r2_access_key_id ?? "",
    r2SecretAccessKey: row.r2_secret_access_key ?? "",
  }
}

export type DashboardAccountSummary = Pick<CloudflareAccount,
  "id" | "label" | "email" | "createdAt" | "cloudflareAccountId" | "status" | "totalBuckets" | "totalObjects" | "totalBytes" | "lastSyncedAt" | "syncStatus" | "syncMessage"
>

export function toDashboardAccountSummary(account: CloudflareAccount): DashboardAccountSummary {
  return {
    id: account.id,
    label: account.label,
    email: account.email,
    createdAt: account.createdAt,
    cloudflareAccountId: account.cloudflareAccountId,
    status: account.status,
    totalBuckets: account.totalBuckets,
    totalObjects: account.totalObjects,
    totalBytes: account.totalBytes,
    lastSyncedAt: account.lastSyncedAt,
    syncStatus: account.syncStatus,
    syncMessage: account.syncMessage,
  }
}

export async function listDashboardAccountSummaries(): Promise<DashboardAccountSummary[]> {
  const { rows } = await queryDb<Pick<DriveAccountRow,
    "id" | "label" | "email" | "created_at" | "cloudflare_account_id" | "status" | "total_buckets" | "total_objects" | "total_bytes" | "last_synced_at" | "sync_status" | "sync_message"
  >>(`
    select id,label,email,created_at,cloudflare_account_id,status,total_buckets,total_objects,total_bytes,last_synced_at,sync_status,sync_message
    from public.${ACCOUNTS_TABLE}
    order by updated_at desc nulls last, created_at desc,id desc
  `)
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    email: row.email,
    status: row.status,
    createdAt: row.created_at,
    cloudflareAccountId: row.cloudflare_account_id ?? undefined,
    totalBuckets: Math.max(0, Number(row.total_buckets) || 0),
    totalObjects: Math.max(0, Number(row.total_objects) || 0),
    totalBytes: Math.max(0, Number(row.total_bytes) || 0),
    lastSyncedAt: row.last_synced_at ?? undefined,
    syncStatus: row.sync_status ?? undefined,
    syncMessage: row.sync_message ?? undefined,
  }))
}

export async function getActiveDashboardAccountSummary(): Promise<DashboardAccountSummary | null> {
  const { rows } = await queryDb<Pick<DriveAccountRow,
    "id" | "label" | "email" | "created_at" | "cloudflare_account_id" | "status" | "total_buckets" | "total_objects" | "total_bytes" | "last_synced_at" | "sync_status" | "sync_message"
  >>(`
    select id,label,email,created_at,cloudflare_account_id,status,total_buckets,total_objects,total_bytes,last_synced_at,sync_status,sync_message
    from public.${ACCOUNTS_TABLE}
    where status='active'
    order by updated_at desc nulls last,created_at desc,id desc
    limit 1
  `)
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    label: row.label,
    email: row.email,
    status: row.status,
    createdAt: row.created_at,
    cloudflareAccountId: row.cloudflare_account_id ?? undefined,
    totalBuckets: Math.max(0, Number(row.total_buckets) || 0),
    totalObjects: Math.max(0, Number(row.total_objects) || 0),
    totalBytes: Math.max(0, Number(row.total_bytes) || 0),
    lastSyncedAt: row.last_synced_at ?? undefined,
    syncStatus: row.sync_status ?? undefined,
    syncMessage: row.sync_message ?? undefined,
  }
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
  const normalizedEmail = input.email.trim().toLowerCase()
  const normalizedLabel = input.label.trim()
  const inserted = await withDbTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('drive_accounts'), hashtext('active-status'))`)
    const checks = await client.query<{
      account_count: string
      email_exists: boolean
      label_exists: boolean
      token_exists: boolean
      r2_exists: boolean
    }>(`
      select count(*)::text as account_count,
        exists(select 1 from public.${ACCOUNTS_TABLE} where email=$1) as email_exists,
        exists(select 1 from public.${ACCOUNTS_TABLE} where lower(label)=lower($2)) as label_exists,
        exists(select 1 from public.${ACCOUNTS_TABLE} where api_token=$3) as token_exists,
        exists(select 1 from public.${ACCOUNTS_TABLE} where $4::text<>'' and r2_access_key_id=$4) as r2_exists
      from public.${ACCOUNTS_TABLE}
    `, [normalizedEmail, normalizedLabel, input.apiToken, input.r2AccessKeyId || ""])
    const check = checks.rows[0]
    if (check.email_exists) throw new Error("An account with this email already exists")
    if (check.label_exists) throw new Error("An account with this label already exists")
    if (check.token_exists) throw new Error("An account with this API token already exists")
    if (check.r2_exists) throw new Error("An account with this R2 access key already exists")

    const status: CloudflareAccountStatus = input.makeActive || Number(check.account_count) === 0 ? "active" : "available"
    if (status === "active") {
      await client.query(`update public.${ACCOUNTS_TABLE} set status='disabled',updated_at=now() where status='active'`)
    }
    const { rows } = await client.query<DriveAccountRow>(`
      insert into public.${ACCOUNTS_TABLE} (
        id,label,email,password,two_factor_secret,api_token,r2_access_key_id,r2_secret_access_key,
        cloudflare_account_id,cloudflare_account_name,status,last_migrated,total_buckets,total_objects,
        total_bytes,last_synced_at,sync_status,sync_message
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,null,null,$9,'-',0,0,0,null,'idle',null)
      returning *
    `, [crypto.randomUUID(), normalizedLabel, normalizedEmail, input.password, input.twoFactorSecret?.trim() || null,
      input.apiToken, input.r2AccessKeyId, input.r2SecretAccessKey, status])
    if (!rows[0]) throw new Error("Failed to create Cloudflare account")
    return rows[0]
  })
  return mapRow(inserted)
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
      | "syncStatus"
      | "syncMessage"
    >
  > & { lastSyncedAt?: string | null }
): Promise<CloudflareAccount> {
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

  const updated = await withDbTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('drive_accounts'), hashtext('active-status'))`)
    const current = (await client.query<DriveAccountRow>(
      `select * from public.${ACCOUNTS_TABLE} where id=$1 for update`, [id]
    )).rows[0]
    if (!current) throw new Error("Account not found")
    if (current.status === "disabled" && updates.status !== undefined && updates.status !== "disabled") {
      throw new Error("Disabled Cloudflare accounts are permanent and cannot be re-enabled")
    }
    if (updates.status !== undefined && updates.status !== "active" && current.status === "active") {
      const result = await client.query(`select
        count(*) filter(where id<>$1)::int remaining,
        count(*) filter(where id<>$1 and status='active')::int active
        from public.${ACCOUNTS_TABLE}`, [id])
      const row = result.rows[0]
      if (Number(row?.remaining || 0) > 0 && Number(row?.active || 0) === 0) {
        throw new Error("At least one Cloudflare account must remain active")
      }
    }
    if (updates.status === "active") {
      await client.query(`update public.${ACCOUNTS_TABLE} set status='disabled',updated_at=now() where status='active' and id<>$1`, [id])
    }
    const columns = Object.keys(dbUpdates)
    if (!columns.length) return current
    const assignments = columns.map((column, index) => `${column}=$${index + 2}`).join(",")
    const result = await client.query<DriveAccountRow>(
      `update public.${ACCOUNTS_TABLE} set ${assignments},updated_at=now() where id=$1 returning *`,
      [id, ...columns.map((column) => dbUpdates[column])]
    )
    if (!result.rows[0]) throw new Error("Account not found")
    return result.rows[0]
  })
  return mapRow(updated)
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
  const lastCommitted = accounts
    .filter((account) => account.lastSyncedAt)
    .sort((a, b) => Date.parse(b.lastSyncedAt || "") - Date.parse(a.lastSyncedAt || ""))[0]
  const retainedSnapshot = target.lastSyncedAt ? target : lastCommitted

  const completedAt =
    typeof input.completedAt === "string" && input.completedAt.trim().length > 0
      ? input.completedAt
      : new Date().toISOString()

  if (target.status === "disabled") {
    throw new Error("Migration target account is disabled and cannot be activated")
  }

  if (target.status === "active") {
    return updateAccount(target.id, {
      lastMigrated: completedAt,
      totalBuckets: retainedSnapshot?.totalBuckets ?? target.totalBuckets,
      totalObjects: retainedSnapshot?.totalObjects ?? target.totalObjects,
      totalBytes: retainedSnapshot?.totalBytes ?? target.totalBytes,
      lastSyncedAt: retainedSnapshot?.lastSyncedAt ?? null,
      syncStatus: "syncing",
      syncMessage: "Awaiting Backend Orchestrator refresh; showing last committed totals",
    })
  }

  try {
    const updated = await updateAccount(target.id, {
      status: "active",
      lastMigrated: completedAt,
      totalBuckets: retainedSnapshot?.totalBuckets ?? target.totalBuckets,
      totalObjects: retainedSnapshot?.totalObjects ?? target.totalObjects,
      totalBytes: retainedSnapshot?.totalBytes ?? target.totalBytes,
      lastSyncedAt: retainedSnapshot?.lastSyncedAt ?? null,
      syncStatus: "syncing",
      syncMessage: "Awaiting Backend Orchestrator refresh; showing last committed totals",
    })
    const rows = await reconcileAccountStatuses({ preferredActiveAccountId: target.id })
    const reconciled = rows.find((account) => account.id === target.id)
    return reconciled ? mapRow(reconciled) : updated
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
      totalBuckets: retainedSnapshot?.totalBuckets ?? activeTarget.totalBuckets,
      totalObjects: retainedSnapshot?.totalObjects ?? activeTarget.totalObjects,
      totalBytes: retainedSnapshot?.totalBytes ?? activeTarget.totalBytes,
      lastSyncedAt: retainedSnapshot?.lastSyncedAt ?? null,
      syncStatus: "syncing",
      syncMessage: "Awaiting Backend Orchestrator refresh; showing last committed totals",
    })
  }
}

export async function deleteAccount(id: string): Promise<void> {
  await withDbTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('drive_accounts'), hashtext('active-status'))`)
    const target = (await client.query<DriveAccountRow>(`select * from public.${ACCOUNTS_TABLE} where id=$1 for update`, [id])).rows[0]
    if (!target) return
    if (target.status === "active") {
      const result = await client.query(`select
        count(*) filter(where id<>$1)::int remaining,
        count(*) filter(where id<>$1 and status='active')::int active
        from public.${ACCOUNTS_TABLE}`, [id])
      const row = result.rows[0]
      if (Number(row?.remaining || 0) > 0 && Number(row?.active || 0) === 0) {
        throw new Error("Cannot delete the last active Cloudflare account")
      }
    }
    const references = await client.query(`select exists(select 1 from public.${MIGRATIONS_TABLE} where source_account_id=$1 or target_account_id=$1) referenced`, [id])
    if (references.rows[0]?.referenced) {
      throw new Error("Cannot delete this account because it is referenced by one or more migrations. Delete/archive those migrations first.")
    }
    await client.query(`
      insert into public.drive_analytics_bucket_snapshots
        (account_id,account_label,account_email,bucket_name,objects,bytes,status,source_updated_at)
      select account_id,$2,$3,bucket_name,objects,bytes,status,updated_at
      from public.drive_bucket_stats where account_id=$1
      on conflict(account_id,bucket_name) do update set account_label=excluded.account_label,
        account_email=excluded.account_email,objects=excluded.objects,bytes=excluded.bytes,status=excluded.status,
        source_updated_at=excluded.source_updated_at,captured_at=now()
    `, [id, target.label, target.email])
    await client.query(`delete from public.${ACCOUNTS_TABLE} where id=$1`, [id])
  })
}
