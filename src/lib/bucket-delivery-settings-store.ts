import { getActiveAccount } from "./accounts-store"
import { isPostgresConfigured, queryDb } from "./db"
import { normalizeMediaAllowedOrigins } from "./project-media-origins.cjs"

export type BucketDeliverySettings = {
  accountId: string
  bucketName: string
  // This is Drive delivery authorization, not Cloudflare's public development URL.
  publicAccessEnabled: boolean
  // null uses the legacy environment fallback; [] explicitly denies cross-origin media reads.
  mediaAllowedOrigins: string[] | null
  createdAt?: string
  updatedAt?: string
}

type BucketDeliverySettingsRow = {
  account_id: string
  bucket_name: string
  public_access_enabled: boolean
  media_allowed_origins: string[] | null
  created_at: string
  updated_at: string
}

let bucketDeliverySchemaReady: Promise<void> | undefined

function mapBucketDeliverySettings(row: BucketDeliverySettingsRow): BucketDeliverySettings {
  return {
    accountId: row.account_id,
    bucketName: row.bucket_name,
    publicAccessEnabled: row.public_access_enabled === true,
    mediaAllowedOrigins: row.media_allowed_origins,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function defaultBucketDeliverySettings(accountId: string, bucketName: string): BucketDeliverySettings {
  return {
    accountId,
    bucketName,
    publicAccessEnabled: true,
    mediaAllowedOrigins: null,
  }
}

export async function ensureBucketDeliverySettingsSchema() {
  if (!isPostgresConfigured()) return
  bucketDeliverySchemaReady ??= (async () => {
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
  })().catch((error) => {
    bucketDeliverySchemaReady = undefined
    throw error
  })
  return bucketDeliverySchemaReady
}

export async function getBucketDeliverySettings(
  accountId: string,
  bucketName: string
): Promise<BucketDeliverySettings> {
  await ensureBucketDeliverySettingsSchema()
  if (!isPostgresConfigured()) return defaultBucketDeliverySettings(accountId, bucketName)
  const { rows } = await queryDb<BucketDeliverySettingsRow>(
    `
      select account_id, bucket_name, public_access_enabled, media_allowed_origins, created_at, updated_at
      from drive_bucket_delivery_settings
      where account_id = $1 and bucket_name = $2
      limit 1;
    `,
    [accountId, bucketName]
  )
  return rows[0] ? mapBucketDeliverySettings(rows[0]) : defaultBucketDeliverySettings(accountId, bucketName)
}

export async function listBucketDeliverySettings(
  accountId: string,
  bucketNames: string[]
): Promise<Map<string, BucketDeliverySettings>> {
  await ensureBucketDeliverySettingsSchema()
  const names = Array.from(new Set(bucketNames.filter(Boolean)))
  const settings = new Map<string, BucketDeliverySettings>(
    names.map((bucketName) => [bucketName, defaultBucketDeliverySettings(accountId, bucketName)])
  )
  if (!isPostgresConfigured() || names.length === 0) return settings
  const { rows } = await queryDb<BucketDeliverySettingsRow>(
    `
      select account_id, bucket_name, public_access_enabled, media_allowed_origins, created_at, updated_at
      from drive_bucket_delivery_settings
      where account_id = $1 and bucket_name = any($2::text[]);
    `,
    [accountId, names]
  )
  for (const row of rows) settings.set(row.bucket_name, mapBucketDeliverySettings(row))
  return settings
}

export async function updateBucketDeliverySettings(input: {
  accountId: string
  bucketName: string
  publicAccessEnabled?: boolean
  mediaAllowedOrigins?: unknown | null
}): Promise<BucketDeliverySettings> {
  const hasPublicAccessUpdate = typeof input.publicAccessEnabled === "boolean"
  const hasOriginsUpdate = input.mediaAllowedOrigins !== undefined
  if (!hasPublicAccessUpdate && !hasOriginsUpdate) {
    throw new Error("No delivery settings change was provided")
  }
  const mediaAllowedOrigins =
    input.mediaAllowedOrigins === null
      ? null
      : hasOriginsUpdate
        ? normalizeMediaAllowedOrigins(input.mediaAllowedOrigins)
        : null
  await ensureBucketDeliverySettingsSchema()
  if (!isPostgresConfigured()) {
    return {
      ...defaultBucketDeliverySettings(input.accountId, input.bucketName),
      ...(hasPublicAccessUpdate ? { publicAccessEnabled: input.publicAccessEnabled! } : {}),
      ...(hasOriginsUpdate ? { mediaAllowedOrigins } : {}),
    }
  }
  const { rows } = await queryDb<BucketDeliverySettingsRow>(
    `
      insert into drive_bucket_delivery_settings
        (account_id, bucket_name, public_access_enabled, media_allowed_origins)
      values ($1, $2, coalesce($3::boolean, true), case when $4::boolean then $5::text[] else null end)
      on conflict (account_id, bucket_name)
      do update set
        public_access_enabled = coalesce($3::boolean, drive_bucket_delivery_settings.public_access_enabled),
        media_allowed_origins = case
          when $4::boolean then excluded.media_allowed_origins
          else drive_bucket_delivery_settings.media_allowed_origins
        end,
        updated_at = now()
      returning account_id, bucket_name, public_access_enabled, media_allowed_origins, created_at, updated_at;
    `,
    [
      input.accountId,
      input.bucketName,
      hasPublicAccessUpdate ? input.publicAccessEnabled : null,
      hasOriginsUpdate,
      mediaAllowedOrigins,
    ]
  )
  return mapBucketDeliverySettings(rows[0])
}

export async function deleteBucketDeliverySettings(accountId: string, bucketName: string): Promise<boolean> {
  await ensureBucketDeliverySettingsSchema()
  if (!isPostgresConfigured()) return false
  const { rowCount } = await queryDb(
    `
      delete from drive_bucket_delivery_settings
      where account_id = $1 and bucket_name = $2;
    `,
    [accountId, bucketName]
  )
  return (rowCount ?? 0) > 0
}

export async function getActiveBucketDeliverySettings(bucketName: string) {
  const account = await getActiveAccount()
  if (!account) return null
  return getBucketDeliverySettings(account.id, bucketName)
}

export async function updateActiveBucketDeliverySettings(input: {
  bucketName: string
  publicAccessEnabled?: boolean
  mediaAllowedOrigins?: unknown | null
}) {
  const account = await getActiveAccount()
  if (!account) throw new Error("No active Cloudflare account is configured")
  return updateBucketDeliverySettings({ accountId: account.id, ...input })
}
