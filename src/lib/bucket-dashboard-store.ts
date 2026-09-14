import { queryDb } from "./db"
import {
  serializeBucketSettingsSnapshot,
  type BucketSnapshotRow,
  type BucketSettingsSnapshot,
} from "./bucket-settings-snapshot-store"

type ProjectSnapshot = {
  id: string
  projectId: string
  name: string
  status: string
  mediaAllowedOrigins: string[] | null
}

type BucketSnapshot = {
  name: string
  snapshot: BucketSettingsSnapshot | null
  objects: number
  bytes: number
  statsStatus: string
  statsError: string | null
  statsUpdatedAt: string | null
  publicAccessEnabled: boolean
  mediaAllowedOrigins: string[] | null
  deliveryCreatedAt: string | null
  deliveryUpdatedAt: string | null
  projects: ProjectSnapshot[]
}

type BootstrapRow = {
  id: string
  label: string
  status: string
  cloudflare_account_id: string | null
  total_buckets: number | string
  total_objects: number | string
  total_bytes: number | string
  last_synced_at: string | null
  sync_status: string | null
  sync_message: string | null
  buckets: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonNegativeInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

function strings(value: unknown): string[] | null {
  if (value === null) return null
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : null
}

function mapProject(value: unknown): ProjectSnapshot | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.name !== "string"
  ) return null
  return {
    id: value.id,
    projectId: value.projectId,
    name: value.name,
    status: typeof value.status === "string" ? value.status : "disabled",
    mediaAllowedOrigins: strings(value.mediaAllowedOrigins),
  }
}

function mapBucket(value: unknown): BucketSnapshot | null {
  if (!isRecord(value) || typeof value.name !== "string") return null
  const snapshot = isRecord(value.snapshot)
    ? serializeBucketSettingsSnapshot(value.snapshot as unknown as BucketSnapshotRow)
    : null
  return {
    name: value.name,
    snapshot,
    objects: nonNegativeInteger(value.objects),
    bytes: nonNegativeInteger(value.bytes),
    statsStatus: typeof value.statsStatus === "string" ? value.statsStatus : "pending",
    statsError: typeof value.statsError === "string" ? value.statsError : null,
    statsUpdatedAt: typeof value.statsUpdatedAt === "string" ? value.statsUpdatedAt : null,
    publicAccessEnabled: value.publicAccessEnabled !== false,
    mediaAllowedOrigins: strings(value.mediaAllowedOrigins),
    deliveryCreatedAt: typeof value.deliveryCreatedAt === "string" ? value.deliveryCreatedAt : null,
    deliveryUpdatedAt: typeof value.deliveryUpdatedAt === "string" ? value.deliveryUpdatedAt : null,
    projects: Array.isArray(value.projects)
      ? value.projects.map(mapProject).filter((project): project is ProjectSnapshot => project !== null)
      : [],
  }
}

/** One database round trip for the buckets page's active account and all display projections. */
export async function getBucketDashboardBootstrap() {
  const { rows } = await queryDb<BootstrapRow>(`
    with active_account as (
      select id,label,status,cloudflare_account_id,total_buckets::text as total_buckets,
        total_objects::text as total_objects,total_bytes::text as total_bytes,last_synced_at,
        sync_status,sync_message
      from public.drive_accounts
      where status='active'
      order by updated_at desc nulls last,created_at desc,id desc
      limit 1
    )
    select active.*,
      coalesce(jsonb_agg(jsonb_build_object(
        'name', names.bucket_name,
        'snapshot', case when snapshot.account_id is null then null else jsonb_build_object(
          'account_id',snapshot.account_id,
          'bucket_name',snapshot.bucket_name,
          'bucket_created_at',snapshot.bucket_created_at,
          'jurisdiction',snapshot.jurisdiction,
          'location',snapshot.location,
          'storage_class',snapshot.storage_class,
          'public_access',snapshot.public_access,
          'cors_rules',snapshot.cors_rules,
          'settings_status',snapshot.settings_status,
          'settings_error',snapshot.settings_error,
          'settings_last_attempted_at',snapshot.settings_last_attempted_at,
          'settings_last_synced_at',snapshot.settings_last_synced_at,
          'inventory_synced_at',snapshot.inventory_synced_at
        ) end,
        'objects',coalesce(stats.objects,0)::text,
        'bytes',coalesce(stats.bytes,0)::text,
        'statsStatus',coalesce(stats.status,'pending'),
        'statsError',stats.error,
        'statsUpdatedAt',stats.updated_at,
        'publicAccessEnabled',coalesce(delivery.public_access_enabled,true),
        'mediaAllowedOrigins',delivery.media_allowed_origins,
        'deliveryCreatedAt',delivery.created_at,
        'deliveryUpdatedAt',delivery.updated_at,
        'projects',coalesce(assigned.projects,'[]'::jsonb)
      ) order by names.bucket_name) filter (where names.bucket_name is not null),'[]'::jsonb) as buckets
    from active_account active
    left join lateral (
      select bucket_name from public.drive_bucket_settings_snapshots where account_id=active.id
      union
      select bucket_name from public.drive_bucket_stats where account_id=active.id
    ) names on true
    left join public.drive_bucket_settings_snapshots snapshot
      on snapshot.account_id=active.id and snapshot.bucket_name=names.bucket_name
    left join public.drive_bucket_stats stats
      on stats.account_id=active.id and stats.bucket_name=names.bucket_name
    left join public.drive_bucket_delivery_settings delivery
      on delivery.account_id=active.id and delivery.bucket_name=names.bucket_name
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'id',project.id,
        'projectId',project.project_id,
        'name',project.name,
        'status',project.status,
        'mediaAllowedOrigins',policy.media_allowed_origins
      ) order by assignment.created_at,project.id) as projects
      from public.drive_project_bucket_assignments assignment
      join public.drive_projects project on project.id=assignment.project_id
      left join public.drive_project_delivery_settings policy on policy.project_id=project.id
      where assignment.account_id=active.id and assignment.bucket_name=names.bucket_name
    ) assigned on true
    group by active.id,active.label,active.status,active.cloudflare_account_id,
      active.total_buckets,active.total_objects,active.total_bytes,active.last_synced_at,
      active.sync_status,active.sync_message
  `)
  const row = rows[0]
  if (!row) return null
  const rawBuckets = Array.isArray(row.buckets) ? row.buckets : []
  return {
    account: {
      id: row.id,
      label: row.label,
      status: row.status,
      cloudflareAccountId: row.cloudflare_account_id ?? undefined,
      totalBuckets: nonNegativeInteger(row.total_buckets),
      totalObjects: nonNegativeInteger(row.total_objects),
      totalBytes: nonNegativeInteger(row.total_bytes),
      lastSyncedAt: row.last_synced_at ?? undefined,
      syncStatus: row.sync_status ?? undefined,
      syncMessage: row.sync_message ?? undefined,
    },
    buckets: rawBuckets.map(mapBucket).filter((bucket): bucket is BucketSnapshot => bucket !== null),
  }
}
