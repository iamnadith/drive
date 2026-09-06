import type { CloudflareAccount } from "./accounts-store"
import { isPostgresConfigured, queryDb } from "./db"
import { allowedStorageCorsOrigins } from "./storage-delivery.cjs"
import {
  getBucketDeliverySettings,
  type BucketDeliverySettings,
  updateBucketDeliverySettings,
} from "./bucket-delivery-settings-store"
import { listProjectDeliverySettings } from "./project-delivery-settings-store"
import { ensureProjectSchema, getAssignedProjectIdsForBucket, listProjectBuckets } from "./projects-store"
import {
  mergeManyMediaAllowedOrigins,
  normalizeMediaAllowedOrigins,
  resolveEffectiveMediaAllowedOrigins,
} from "./project-media-origins.cjs"
import { reconcileBucketDeliveryCorsRule } from "./r2-bucket-settings"

let reconciliationSchemaReady: Promise<void> | undefined

async function ensureDeliveryReconciliationSchema() {
  if (!isPostgresConfigured()) return
  reconciliationSchemaReady ??= queryDb(`
    create table if not exists drive_project_delivery_sync_state (
      account_id uuid not null references drive_accounts(id) on delete cascade,
      bucket_name text not null,
      status text not null default 'pending',
      desired_origins text[] not null default '{}',
      changed boolean not null default false,
      last_checked_at timestamptz,
      last_synced_at timestamptz,
      failure_count integer not null default 0,
      next_attempt_at timestamptz,
      error text,
      primary key (account_id, bucket_name)
    );
  `).then(async () => {
    await queryDb(`alter table drive_project_delivery_sync_state add column if not exists failure_count integer not null default 0;`)
    await queryDb(`alter table drive_project_delivery_sync_state add column if not exists next_attempt_at timestamptz;`)
  }).then(() => undefined).catch((error) => {
    reconciliationSchemaReady = undefined
    throw error
  })
  return reconciliationSchemaReady
}

export async function queueBucketDeliveryCorsReconciliation(accountId: string, bucketName: string) {
  await ensureDeliveryReconciliationSchema()
  if (!isPostgresConfigured()) return
  await queryDb(
    `
      insert into drive_project_delivery_sync_state
        (account_id, bucket_name, status, changed, last_checked_at, failure_count, next_attempt_at, error)
      values ($1, $2, 'pending', false, null, 0, null, null)
      on conflict (account_id, bucket_name) do update set
        status = 'pending', changed = false, last_checked_at = null,
        failure_count = 0, next_attempt_at = null, error = null;
    `,
    [accountId, bucketName]
  )
}

export async function deleteBucketDeliveryCorsReconciliation(accountId: string, bucketName: string) {
  await ensureDeliveryReconciliationSchema()
  if (!isPostgresConfigured()) return
  await queryDb(
    `delete from drive_project_delivery_sync_state where account_id = $1 and bucket_name = $2`,
    [accountId, bucketName]
  )
}

export async function getEffectiveBucketMediaOrigins(accountId: string, bucketName: string, settings: BucketDeliverySettings) {
  const projectIds = await getAssignedProjectIdsForBucket(accountId, bucketName)
  const projectSettings = await listProjectDeliverySettings(projectIds)
  const inheritedPolicies = projectIds
    .map((projectId) => projectSettings.get(projectId)?.mediaAllowedOrigins ?? null)
    .filter((origins): origins is string[] => Array.isArray(origins))
  const inherited = inheritedPolicies.length > 0
    ? mergeManyMediaAllowedOrigins(inheritedPolicies)
    : null
  const manual = settings.mediaAllowedOrigins
  const effectiveMediaAllowedOrigins = resolveEffectiveMediaAllowedOrigins({
    inheritedPolicies,
    manual,
    fallback: allowedStorageCorsOrigins().filter((origin): origin is string => typeof origin === "string"),
  })
  return {
    projectId: projectIds[0] ?? null,
    projectIds,
    inheritedMediaAllowedOrigins: inherited,
    manualMediaAllowedOrigins: manual,
    effectiveMediaAllowedOrigins,
  }
}

export async function assertProjectDeliveryOriginsFitAssignedBuckets(input: {
  projectId: string
  mediaAllowedOrigins: unknown | null
}) {
  const candidateOrigins = input.mediaAllowedOrigins === null
    ? null
    : normalizeMediaAllowedOrigins(input.mediaAllowedOrigins)
  const buckets = await listProjectBuckets(input.projectId)
  for (const bucket of buckets) {
    if (!bucket.accountId) continue
    const projectIds = await getAssignedProjectIdsForBucket(bucket.accountId, bucket.bucketName)
    const settings = await listProjectDeliverySettings(projectIds)
    mergeManyMediaAllowedOrigins(projectIds.map((projectId) =>
      projectId === input.projectId
        ? candidateOrigins
        : settings.get(projectId)?.mediaAllowedOrigins ?? null
    ))
  }
}

/**
 * Persists Drive delivery policy as desired state, queues durable repair, then
 * attempts an immediate provider sync. Provider propagation or outages never
 * discard an accepted policy; the worker keeps verifying it until it matches.
 */
export async function updateAndSyncBucketDeliverySettings(input: {
  account: CloudflareAccount
  bucketName: string
  publicAccessEnabled?: boolean
  mediaAllowedOrigins?: unknown | null
}) {
  if (input.mediaAllowedOrigins !== undefined) {
    const before = await getBucketDeliverySettings(input.account.id, input.bucketName)
    const candidateOrigins = input.mediaAllowedOrigins === null
      ? null
      : normalizeMediaAllowedOrigins(input.mediaAllowedOrigins)
    await getEffectiveBucketMediaOrigins(input.account.id, input.bucketName, {
      ...before,
      mediaAllowedOrigins: candidateOrigins,
    })
  }
  const settings = await updateBucketDeliverySettings({
    accountId: input.account.id,
    bucketName: input.bucketName,
    ...(typeof input.publicAccessEnabled === "boolean"
      ? { publicAccessEnabled: input.publicAccessEnabled }
      : {}),
    ...(input.mediaAllowedOrigins !== undefined ? { mediaAllowedOrigins: input.mediaAllowedOrigins } : {}),
  })

  if (input.mediaAllowedOrigins === undefined) return { settings, deliverySyncPending: false }
  await queueBucketDeliveryCorsReconciliation(input.account.id, input.bucketName)
  try {
    await syncEffectiveBucketDeliveryCors({ account: input.account, bucketName: input.bucketName })
    return { settings, deliverySyncPending: false }
  } catch {
    // The durable pending row is intentionally retained for worker repair.
    return { settings, deliverySyncPending: true }
  }
}

export async function syncEffectiveBucketDeliveryCors(input: {
  account: CloudflareAccount
  bucketName: string
}) {
  const settings = await getBucketDeliverySettings(input.account.id, input.bucketName)
  const effective = await getEffectiveBucketMediaOrigins(input.account.id, input.bucketName, settings)
  const cors = await reconcileBucketDeliveryCorsRule(input.account, input.bucketName, effective.effectiveMediaAllowedOrigins)
  return { settings, ...effective, corsChanged: cors.changed }
}

export async function syncProjectDeliveryCors(input: {
  account: CloudflareAccount
  projectIdentifier: string
}) {
  const buckets = await listProjectBuckets(input.projectIdentifier)
  const results = []
  const failures: Array<{ bucketName: string; error: unknown }> = []
  for (const bucket of buckets.filter((bucket) => bucket.accountId === input.account.id)) {
    try {
      results.push(await syncEffectiveBucketDeliveryCors({ account: input.account, bucketName: bucket.bucketName }))
    } catch (error) {
      failures.push({ bucketName: bucket.bucketName, error })
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `Unable to synchronize delivery CORS for ${failures.map((failure) => failure.bucketName).join(", ")}`
    )
  }
  return results
}

export async function reconcileAssignedProjectDeliveryCors(input: {
  account: CloudflareAccount
  limit?: number
}) {
  await ensureProjectSchema()
  await ensureDeliveryReconciliationSchema()
  if (!isPostgresConfigured()) return { checked: 0, changed: 0, unchanged: 0, errors: [] }
  const limit = Math.max(1, Math.min(25, Math.floor(input.limit ?? 5)))
  const { rows } = await queryDb<{ bucket_name: string }>(
    `
      select candidate.bucket_name
      from (
        select assignment.bucket_name
        from drive_project_bucket_assignments assignment
        where assignment.account_id = $1
        union
        select queued.bucket_name
        from drive_project_delivery_sync_state queued
        where queued.account_id = $1
      ) candidate
      left join drive_project_delivery_sync_state state
        on state.account_id = $1 and state.bucket_name = candidate.bucket_name
      where state.next_attempt_at is null or state.next_attempt_at <= now()
      order by state.last_checked_at asc nulls first, candidate.bucket_name asc
      limit $2;
    `,
    [input.account.id, limit]
  )
  const results: Array<{ bucketName: string; ok: boolean; changed?: boolean; error?: string }> = []
  for (const row of rows) {
    try {
      const result = await syncEffectiveBucketDeliveryCors({ account: input.account, bucketName: row.bucket_name })
      await queryDb(
        `
          insert into drive_project_delivery_sync_state
            (account_id, bucket_name, status, desired_origins, changed, last_checked_at, last_synced_at, error)
          values ($1, $2, 'ok', $3::text[], $4, now(), case when $4 then now() else null end, null)
          on conflict (account_id, bucket_name) do update set
            status = 'ok', desired_origins = excluded.desired_origins, changed = excluded.changed,
            last_checked_at = now(),
            last_synced_at = case when excluded.changed then now() else drive_project_delivery_sync_state.last_synced_at end,
            failure_count = 0, next_attempt_at = null,
            error = null;
        `,
        [input.account.id, row.bucket_name, result.effectiveMediaAllowedOrigins, result.corsChanged]
      )
      results.push({ bucketName: row.bucket_name, ok: true, changed: result.corsChanged })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await queryDb(
        `
          insert into drive_project_delivery_sync_state
            (account_id, bucket_name, status, changed, last_checked_at, failure_count, next_attempt_at, error)
          values ($1, $2, 'error', false, now(), 1, now() + interval '30 seconds', $3)
          on conflict (account_id, bucket_name) do update set
            status = 'error', changed = false, last_checked_at = now(),
            failure_count = drive_project_delivery_sync_state.failure_count + 1,
            next_attempt_at = now() + make_interval(secs => least(3600, 30 * power(2, least(drive_project_delivery_sync_state.failure_count, 7))::int)),
            error = excluded.error;
        `,
        [input.account.id, row.bucket_name, message]
      ).catch(() => undefined)
      results.push({ bucketName: row.bucket_name, ok: false, error: message })
    }
  }
  return {
    checked: results.length,
    changed: results.filter((result) => result.changed === true).length,
    unchanged: results.filter((result) => result.ok && result.changed === false).length,
    errors: results.filter((result) => !result.ok),
  }
}
