import { queryDb } from "./db"
import type { BucketSettings } from "./r2-bucket-settings"

type BucketSnapshotRow = {
  account_id: string
  bucket_name: string
  bucket_created_at: string | null
  jurisdiction: string
  location: string | null
  storage_class: string
  public_access: unknown
  cors_rules: unknown
  settings_status: string
  settings_error: string | null
  settings_last_attempted_at: string | null
  settings_last_synced_at: string | null
  inventory_synced_at: string
}

export type BucketSettingsSnapshot = {
  accountId: string
  bucketName: string
  createdAt: string | null
  jurisdiction: string
  location: string | null
  storageClass: string
  settings: BucketSettings | null
  settingsStatus: string
  settingsError: string | null
  settingsLastAttemptedAt: string | null
  settingsLastSyncedAt: string | null
  inventorySyncedAt: string
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function settingsFromRow(row: BucketSnapshotRow): BucketSettings | null {
  if (!row.settings_last_synced_at) return null
  const publicAccess = row.public_access && typeof row.public_access === "object"
    ? row.public_access as Record<string, unknown>
    : {}
  const corsRules = Array.isArray(row.cors_rules)
    ? row.cors_rules.flatMap((value) => {
        if (!value || typeof value !== "object") return []
        const rule = value as Record<string, unknown>
        const allowedOrigins = strings(rule.allowedOrigins)
        const allowedMethods = strings(rule.allowedMethods)
        if (allowedOrigins.length === 0 || allowedMethods.length === 0) return []
        return [{
          ...(typeof rule.id === "string" ? { id: rule.id } : {}),
          allowedOrigins,
          allowedMethods,
          allowedHeaders: strings(rule.allowedHeaders),
          exposeHeaders: strings(rule.exposeHeaders),
          ...(typeof rule.maxAgeSeconds === "number" ? { maxAgeSeconds: rule.maxAgeSeconds } : {}),
        }]
      })
    : []
  return {
    publicAccess: {
      enabled: publicAccess.enabled === true,
      domain: typeof publicAccess.domain === "string" ? publicAccess.domain : null,
      bucketId: typeof publicAccess.bucketId === "string" ? publicAccess.bucketId : null,
    },
    corsRules,
  }
}

function serialize(row: BucketSnapshotRow): BucketSettingsSnapshot {
  return {
    accountId: row.account_id,
    bucketName: row.bucket_name,
    createdAt: row.bucket_created_at,
    jurisdiction: row.jurisdiction,
    location: row.location,
    storageClass: row.storage_class,
    settings: settingsFromRow(row),
    settingsStatus: row.settings_status,
    settingsError: row.settings_error,
    settingsLastAttemptedAt: row.settings_last_attempted_at,
    settingsLastSyncedAt: row.settings_last_synced_at,
    inventorySyncedAt: row.inventory_synced_at,
  }
}

export async function listBucketSettingsSnapshots(accountId: string) {
  const result = await queryDb<BucketSnapshotRow>(`
    select account_id,bucket_name,bucket_created_at,jurisdiction,location,storage_class,
           public_access,cors_rules,settings_status,settings_error,
           settings_last_attempted_at,settings_last_synced_at,inventory_synced_at
    from drive_bucket_settings_snapshots
    where account_id=$1
    order by bucket_name
  `, [accountId])
  return result.rows.map(serialize)
}

export async function upsertBucketSettingsSnapshot(
  accountId: string,
  bucketName: string,
  settings: BucketSettings
) {
  await queryDb(`
    insert into drive_bucket_settings_snapshots
      (account_id,bucket_name,public_access,cors_rules,settings_status,settings_error,
       settings_last_attempted_at,settings_last_synced_at,inventory_synced_at,updated_at)
    values ($1,$2,$3::jsonb,$4::jsonb,'completed',null,now(),now(),now(),now())
    on conflict(account_id,bucket_name) do update set
      public_access=excluded.public_access,
      cors_rules=excluded.cors_rules,
      settings_status='completed',
      settings_error=null,
      settings_last_attempted_at=now(),
      settings_last_synced_at=now(),
      updated_at=now()
  `, [accountId, bucketName, JSON.stringify(settings.publicAccess), JSON.stringify(settings.corsRules)])
}

export async function deleteBucketSettingsSnapshot(accountId: string, bucketName: string) {
  await queryDb(
    `delete from drive_bucket_settings_snapshots where account_id=$1 and bucket_name=$2`,
    [accountId, bucketName]
  )
}
