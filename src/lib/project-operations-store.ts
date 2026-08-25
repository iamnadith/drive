import crypto from "crypto"
import { queryDb } from "./db"
import { scheduleDatabaseMaintenance } from "./database-maintenance"
import { getActiveProjectBucketR2Config } from "./project-api-auth"
import { getProjectByIdentifier, hashProjectSecret, type Project } from "./projects-store"
import {
  r2CopyObject,
  r2DeleteObject,
  r2DeleteObjects,
  r2HeadObject,
  r2ListObjectsPage,
  type R2ClientConfig,
} from "./r2-s3"

declare global {
  var __driveProjectOperationsSchema: Promise<void> | undefined
}

export type ProjectOperationType =
  | "recursive_delete"
  | "batch_delete"
  | "batch_copy"
  | "batch_move"
  | "prefix_rename"
  | "inventory_scan"

export type ProjectOperationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"

export type ProjectOperationJob = {
  id: string
  projectId: string
  type: ProjectOperationType
  status: ProjectOperationStatus
  payload: Record<string, unknown>
  progress: Record<string, unknown>
  result: Record<string, unknown>
  error?: string
  idempotencyKey?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
}

type JobRow = {
  id: string
  project_id: string
  type: ProjectOperationType
  status: ProjectOperationStatus
  payload: Record<string, unknown>
  progress: Record<string, unknown>
  result: Record<string, unknown>
  error: string | null
  idempotency_key: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
}

type InventoryRow = {
  file_id: string
  project_id: string
  bucket_name: string
  object_key: string
  size: string | number
  etag: string | null
  content_type: string | null
  metadata: Record<string, unknown> | null
  last_modified: string | null
  deleted_at: string | null
  updated_at: string
}

export type ProjectInventoryObject = {
  fileId: string
  projectId: string
  bucketName: string
  key: string
  size: number
  etag?: string
  contentType?: string
  metadata: Record<string, unknown>
  lastModified?: string
  deletedAt?: string
  updatedAt: string
}

function mapJob(row: JobRow): ProjectOperationJob {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    payload: row.payload ?? {},
    progress: row.progress ?? {},
    result: row.result ?? {},
    error: row.error ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  }
}

function asString(value: unknown) {
  return typeof value === "string" ? value : ""
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : []
}

function mapInventoryRow(row: InventoryRow): ProjectInventoryObject {
  return {
    fileId: row.file_id,
    projectId: row.project_id,
    bucketName: row.bucket_name,
    key: row.object_key,
    size: Number(row.size ?? 0),
    etag: row.etag ?? undefined,
    contentType: row.content_type ?? undefined,
    metadata: row.metadata ?? {},
    lastModified: row.last_modified ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    updatedAt: row.updated_at,
  }
}

async function findProjectIdsForTrackedBucket(bucketName: string) {
  await ensureProjectOperationsSchema()
  const { rows } = await queryDb<{ project_id: string }>(
    `
      select distinct project_id
      from drive_project_bucket_assignments
      where bucket_name = $1;
    `,
    [bucketName]
  )
  return rows.map((row) => row.project_id)
}

export function ensureProjectOperationsSchema(): Promise<void> {
  if (!global.__driveProjectOperationsSchema) {
    global.__driveProjectOperationsSchema = (async () => {
      await queryDb(`create extension if not exists pgcrypto;`)
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
    create index if not exists drive_project_api_events_recent_objects_idx
      on drive_project_api_events (project_id, action, occurred_at desc, object_key)
      where outcome = 'success' and object_key is not null;
  `)

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
    })().catch((error) => {
      global.__driveProjectOperationsSchema = undefined
      throw error
    })
  }
  return global.__driveProjectOperationsSchema
}

export function getRequestApiContext(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return {
    ipAddress: forwardedFor || request.headers.get("x-real-ip") || null,
    userAgent: request.headers.get("user-agent") || null,
    requestId: request.headers.get("x-request-id") || crypto.randomUUID(),
  }
}

export async function recordProjectApiEvent(input: {
  project?: Project | null
  apiKeyId?: string | null
  action: string
  objectKey?: string | null
  status?: number | null
  outcome?: "success" | "failed" | "warning"
  request?: Request
  metadata?: Record<string, unknown>
}) {
  try {
    await ensureProjectOperationsSchema()
    const ctx = input.request
      ? getRequestApiContext(input.request)
      : { ipAddress: null, userAgent: null, requestId: null }
    await queryDb(
      `
        insert into drive_project_api_events
          (project_id, api_key_id, action, object_key, status, outcome, ip_address, user_agent, request_id, metadata)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::jsonb, '{}'::jsonb));
      `,
      [
        input.project?.id ?? null,
        input.apiKeyId ?? null,
        input.action,
        input.objectKey ?? null,
        input.status ?? null,
        input.outcome ?? "success",
        ctx.ipAddress ?? null,
        ctx.userAgent ?? null,
        ctx.requestId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ]
    )
    scheduleDatabaseMaintenance()
  } catch (error) {
    console.error("Unable to record project API event:", error)
  }
}

/**
 * Return recently completed object keys for a project.  R2's native list API
 * is ordered by key, not upload time, so a resumable key cursor can take a
 * long time to reach a newly uploaded object.  Upload/put routes already
 * record these events; keeping this query bounded gives consumers a cheap
 * recent window without walking the whole bucket.
 */
export async function getRecentProjectObjectKeys(input: {
  projectId: string
  limit: number
}) {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit)))
  try {
    const { rows } = await queryDb<{ object_key: string; occurred_at: string }>(
      `
        select e.object_key, max(e.occurred_at) as occurred_at
        from drive_project_api_events e
        where e.project_id = $1
          and e.object_key is not null
          and e.outcome = 'success'
          and e.action = any($2::text[])
        group by e.object_key
        order by max(e.occurred_at) desc, e.object_key desc
        limit $3;
      `,
      [
        input.projectId,
        [
          "storage.object.put",
          "file.upload.complete",
          "file.multipart.complete",
        ],
        limit,
      ]
    )
    return rows
  } catch (error) {
    // This is an optional acceleration path.  A project created before the
    // event table existed (or a transient database read failure) must fall
    // back to the worker's durable R2 cursor instead of failing discovery.
    console.warn("Unable to read recent project object events:", error)
    return []
  }
}

export async function upsertProjectObjectInventory(input: {
  projectId: string
  bucketName: string
  key: string
  fileId?: string
  size?: number
  etag?: string
  contentType?: string
  metadata?: Record<string, unknown>
  lastModified?: string
}) {
  await ensureProjectOperationsSchema()
  const { rows } = await queryDb<InventoryRow>(
    `
      insert into drive_project_object_inventory
        (project_id, bucket_name, object_key, file_id, size, etag, content_type, metadata, last_modified, deleted_at)
      values ($1, $2, $3, coalesce($4, encode(gen_random_bytes(12), 'hex')), $5, $6, $7, coalesce($8::jsonb, '{}'::jsonb), $9, null)
      on conflict (project_id, bucket_name, object_key) do update set
        size = excluded.size,
        etag = excluded.etag,
        content_type = excluded.content_type,
        metadata = excluded.metadata,
        last_modified = excluded.last_modified,
        deleted_at = null,
        updated_at = now()
      returning *;
    `,
    [
      input.projectId,
      input.bucketName,
      input.key,
      input.fileId ?? null,
      input.size ?? 0,
      input.etag ?? null,
      input.contentType ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.lastModified ?? null,
    ]
  )
  return mapInventoryRow(rows[0])
}

/**
 * Index an R2 list page in one statement. Inventory scans are resumable at an
 * R2 page boundary, so there is no need to pay for one round trip per object.
 */
export async function upsertProjectObjectInventoryBatch(input: {
  projectId: string
  bucketName: string
  objects: Array<{
    key: string
    size?: number
    etag?: string
    lastModified?: string
  }>
}) {
  const unique = new Map<string, (typeof input.objects)[number]>()
  for (const object of input.objects) {
    const key = object.key.trim()
    if (key) unique.set(key, { ...object, key })
  }
  const objects = [...unique.values()]
  if (!objects.length) return

  await ensureProjectOperationsSchema()
  await queryDb(
    `
      insert into drive_project_object_inventory
        (project_id, bucket_name, object_key, file_id, size, etag, metadata, last_modified, deleted_at)
      select $1, $2, rows.object_key, encode(gen_random_bytes(12), 'hex'), rows.size,
             rows.etag, '{}'::jsonb, rows.last_modified, null
      from unnest(
        $3::text[], $4::bigint[], $5::text[], $6::timestamptz[]
      ) as rows(object_key, size, etag, last_modified)
      on conflict (project_id, bucket_name, object_key) do update set
        size = excluded.size,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        deleted_at = null,
        updated_at = now();
    `,
    [
      input.projectId,
      input.bucketName,
      objects.map((object) => object.key),
      objects.map((object) => object.size ?? 0),
      objects.map((object) => object.etag ?? null),
      objects.map((object) => object.lastModified ?? null),
    ]
  )
}

export async function getProjectObjectInventoryByKey(projectId: string, bucketName: string, key: string) {
  await ensureProjectOperationsSchema()
  const { rows } = await queryDb<InventoryRow>(
    `
      select *
      from drive_project_object_inventory
      where project_id = $1 and bucket_name = $2 and object_key = $3
      limit 1;
    `,
    [projectId, bucketName, key]
  )
  return rows[0] ? mapInventoryRow(rows[0]) : null
}

export async function getProjectObjectInventoryByFileId(projectId: string, fileId: string) {
  await ensureProjectOperationsSchema()
  const { rows } = await queryDb<InventoryRow>(
    `
      select *
      from drive_project_object_inventory
      where project_id = $1 and file_id = $2 and deleted_at is null
      limit 1;
    `,
    [projectId, fileId]
  )
  return rows[0] ? mapInventoryRow(rows[0]) : null
}

export async function getProjectObjectInventoriesByKeys(input: {
  projectId: string
  bucketName: string
  keys: string[]
}) {
  await ensureProjectOperationsSchema()
  if (!input.keys.length) return new Map<string, ProjectInventoryObject>()
  const { rows } = await queryDb<InventoryRow>(
    `
      select *
      from drive_project_object_inventory
      where project_id = $1
        and bucket_name = $2
        and object_key = any($3::text[])
        and deleted_at is null;
    `,
    [input.projectId, input.bucketName, input.keys]
  )
  return new Map(rows.map((row) => [row.object_key, mapInventoryRow(row)]))
}

export async function markProjectObjectDeleted(projectId: string, bucketName: string, key: string) {
  await ensureProjectOperationsSchema()
  await queryDb(
    `
      insert into drive_project_object_inventory (project_id, bucket_name, object_key, deleted_at)
      values ($1, $2, $3, now())
      on conflict (project_id, bucket_name, object_key) do update set deleted_at = now(), updated_at = now();
    `,
    [projectId, bucketName, key]
  )
}

/**
 * Mark a set of objects deleted with one database statement.  Delete jobs can
 * contain up to a full R2 page (1,000 keys); issuing one INSERT/UPDATE per key
 * creates a burst of pooled connections and was the largest avoidable CPU
 * spike in the Drive delete paths.
 */
export async function markProjectObjectsDeleted(
  projectId: string,
  bucketName: string,
  keys: string[]
) {
  const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))]
  if (!uniqueKeys.length) return
  await ensureProjectOperationsSchema()
  await queryDb(
    `
      insert into drive_project_object_inventory (project_id, bucket_name, object_key, deleted_at)
      select $1, $2, object_key, now()
      from unnest($3::text[]) as keys(object_key)
      on conflict (project_id, bucket_name, object_key)
      do update set deleted_at = now(), updated_at = now();
    `,
    [projectId, bucketName, uniqueKeys]
  )
}

export async function renameProjectObjectInventory(input: {
  projectId: string
  bucketName: string
  fromKey: string
  toKey: string
  size?: number
  etag?: string
  contentType?: string
  metadata?: Record<string, unknown>
  lastModified?: string
}) {
  await ensureProjectOperationsSchema()
  const source = await getProjectObjectInventoryByKey(input.projectId, input.bucketName, input.fromKey)
  await queryDb(
    `
      delete from drive_project_object_inventory
      where project_id = $1 and bucket_name = $2 and object_key = $3 and object_key <> $4;
    `,
    [input.projectId, input.bucketName, input.toKey, input.fromKey]
  )
  const { rows } = await queryDb<InventoryRow>(
    `
      update drive_project_object_inventory
      set object_key = $4,
          size = $5,
          etag = $6,
          content_type = $7,
          metadata = coalesce($8::jsonb, '{}'::jsonb),
          last_modified = $9,
          deleted_at = null,
          updated_at = now()
      where project_id = $1 and bucket_name = $2 and object_key = $3
      returning *;
    `,
    [
      input.projectId,
      input.bucketName,
      input.fromKey,
      input.toKey,
      input.size ?? 0,
      input.etag ?? null,
      input.contentType ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.lastModified ?? null,
    ]
  )
  if (rows[0]) return mapInventoryRow(rows[0])
  return upsertProjectObjectInventory({
    projectId: input.projectId,
    bucketName: input.bucketName,
    key: input.toKey,
    fileId: source?.fileId,
    size: input.size,
    etag: input.etag,
    contentType: input.contentType,
    metadata: input.metadata,
    lastModified: input.lastModified,
  })
}

export async function syncTrackedBucketObject(input: {
  config: R2ClientConfig
  bucketName: string
  key: string
  projectId?: string
}) {
  const head = await r2HeadObject(input.config, input.bucketName, input.key).catch(() => null)
  if (!head) return null

  const projectIds = input.projectId ? [input.projectId] : await findProjectIdsForTrackedBucket(input.bucketName)
  const results = await Promise.all(
    projectIds.map((projectId) =>
      upsertProjectObjectInventory({
        projectId,
        bucketName: input.bucketName,
        key: input.key,
        size: head.ContentLength ?? 0,
        etag: head.ETag,
        contentType: head.ContentType,
        metadata: head.Metadata,
        lastModified: head.LastModified?.toISOString(),
      }).catch(() => undefined)
    )
  )
  return input.projectId ? (results.find(Boolean) ?? null) : null
}

export async function syncRenamedTrackedBucketObject(input: {
  config: R2ClientConfig
  projectId: string
  bucketName: string
  fromKey: string
  toKey: string
}) {
  const head = await r2HeadObject(input.config, input.bucketName, input.toKey).catch(() => null)
  if (!head) return null
  return renameProjectObjectInventory({
    projectId: input.projectId,
    bucketName: input.bucketName,
    fromKey: input.fromKey,
    toKey: input.toKey,
    size: head.ContentLength ?? 0,
    etag: head.ETag,
    contentType: head.ContentType,
    metadata: head.Metadata,
    lastModified: head.LastModified?.toISOString(),
  })
}

export async function markTrackedBucketObjectDeleted(input: {
  bucketName: string
  key: string
  projectId?: string
}) {
  const projectIds = input.projectId ? [input.projectId] : await findProjectIdsForTrackedBucket(input.bucketName)
  await Promise.all(
    projectIds.map((projectId) =>
      markProjectObjectDeleted(projectId, input.bucketName, input.key).catch(() => undefined)
    )
  )
}

export async function markTrackedBucketObjectsDeleted(input: {
  bucketName: string
  keys: string[]
  projectId?: string
}) {
  const uniqueKeys = [...new Set(input.keys.map((key) => key.trim()).filter(Boolean))]
  if (!uniqueKeys.length) return
  const projectIds = input.projectId ? [input.projectId] : await findProjectIdsForTrackedBucket(input.bucketName)
  await Promise.all(
    projectIds.map((projectId) =>
      markProjectObjectsDeleted(projectId, input.bucketName, uniqueKeys).catch(() => undefined)
    )
  )
}

export async function markTrackedBucketPrefixDeleted(input: {
  bucketName: string
  prefix: string
  projectId?: string
}) {
  const projectIds = input.projectId ? [input.projectId] : await findProjectIdsForTrackedBucket(input.bucketName)
  await Promise.all(
    projectIds.map((projectId) =>
      queryDb(
        `
          update drive_project_object_inventory
          set deleted_at = now(), updated_at = now()
          where project_id = $1 and bucket_name = $2 and object_key like $3;
        `,
        [projectId, input.bucketName, `${input.prefix}%`]
      ).catch(() => undefined)
    )
  )
}

export async function assertProjectObjectWritable(
  projectId: string,
  bucketName: string,
  key: string,
  lockToken?: string | null
) {
  await ensureProjectOperationsSchema()
  const { rows } = await queryDb<{ lock_token_hash: string; expires_at: string | null }>(
    `
      select lock_token_hash, expires_at
      from drive_project_object_locks
      where project_id = $1
        and bucket_name = $2
        and object_key = $3
        and (expires_at is null or expires_at > now())
      limit 1;
    `,
    [projectId, bucketName, key]
  )
  const lock = rows[0]
  if (!lock) return
  if (lockToken && hashProjectSecret(lockToken) === lock.lock_token_hash) return
  throw new Error("Object is locked")
}

export async function assertProjectBucketHasNoActiveLocks(projectId: string, bucketName: string) {
  await ensureProjectOperationsSchema()
  const { rows } = await queryDb<{ count: string }>(
    `select count(*)::text as count from drive_project_object_locks where project_id = $1 and bucket_name = $2 and (expires_at is null or expires_at > now())`,
    [projectId, bucketName]
  )
  if (Number(rows[0]?.count ?? 0) > 0) throw new Error(`Bucket ${bucketName} contains locked objects; clear or release locks first`)
}

export async function clearProjectObjectLock(input: {
  projectId: string
  bucketName: string
  key: string
}) {
  await ensureProjectOperationsSchema()
  await queryDb(
    `
      delete from drive_project_object_locks
      where project_id = $1 and bucket_name = $2 and object_key = $3;
    `,
    [input.projectId, input.bucketName, input.key]
  )
}

export async function searchProjectInventory(input: {
  projectId: string
  bucketName: string
  q?: string
  prefix?: string
  cursor?: string
  limit?: number
}) {
  await ensureProjectOperationsSchema()
  const limit = Math.max(1, Math.min(1000, Math.floor(input.limit ?? 100)))
  const params: unknown[] = [input.projectId, input.bucketName]
  const clauses = ["project_id = $1", "bucket_name = $2", "deleted_at is null"]
  if (input.q?.trim()) {
    params.push(`%${input.q.trim()}%`)
    clauses.push(`object_key ilike $${params.length}`)
  }
  if (input.prefix?.trim()) {
    params.push(`${input.prefix.trim()}%`)
    clauses.push(`object_key like $${params.length}`)
  }
  if (input.cursor?.trim()) {
    params.push(input.cursor.trim())
    clauses.push(`object_key > $${params.length}`)
  }
  params.push(limit + 1)
  const { rows } = await queryDb<{
    file_id: string
    object_key: string
    size: string | number
    etag: string | null
    content_type: string | null
    last_modified: string | null
  }>(
    `
      select file_id, object_key, size, etag, content_type, last_modified
      from drive_project_object_inventory
      where ${clauses.join(" and ")}
      order by object_key asc
      limit $${params.length};
    `,
    params
  )
  const page = rows.slice(0, limit)
  return {
    objects: page.map((row) => ({
      fileId: row.file_id,
      key: row.object_key,
      size: Number(row.size),
      etag: row.etag ?? undefined,
      contentType: row.content_type ?? undefined,
      lastModified: row.last_modified ?? undefined,
    })),
    nextCursor: rows.length > limit && page.length ? page[page.length - 1].object_key : null,
  }
}

export async function getProjectApiUsage(input: {
  projectId?: string
  action?: string
  outcome?: string
  from?: string
  to?: string
  cursor?: string
  limit?: number
}) {
  await ensureProjectOperationsSchema()
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)))
  const params: unknown[] = []
  const clauses: string[] = []
  const add = (value: unknown) => {
    params.push(value)
    return `$${params.length}`
  }

  if (input.projectId) clauses.push(`p.project_id = ${add(input.projectId)}`)
  if (input.action) clauses.push(`e.action = ${add(input.action)}`)
  if (input.outcome) clauses.push(`e.outcome = ${add(input.outcome)}`)
  if (input.from) clauses.push(`e.occurred_at >= ${add(input.from)}::timestamptz`)
  if (input.to) clauses.push(`e.occurred_at <= ${add(input.to)}::timestamptz`)
  if (input.cursor) clauses.push(`(e.occurred_at, e.id) < (${add(input.cursor.split("|")[0])}::timestamptz, ${add(input.cursor.split("|")[1])}::uuid)`)
  const where = clauses.length ? `where ${clauses.join(" and ")}` : ""

  const summary = await queryDb<{
    total: string
    success: string
    failed: string
    rate_limited: string
    unique_keys: string
    unique_projects: string
  }>(
    `
      select
        count(*)::bigint as total,
        count(*) filter (where e.outcome = 'success')::bigint as success,
        count(*) filter (where e.outcome = 'failed')::bigint as failed,
        count(*) filter (where e.status = 429)::bigint as rate_limited,
        count(distinct e.api_key_id)::bigint as unique_keys,
        count(distinct e.project_id)::bigint as unique_projects
      from drive_project_api_events e
      left join drive_projects p on p.id = e.project_id
      ${where};
    `,
    params
  )

  const byAction = await queryDb<{ action: string; count: string }>(
    `
      select e.action, count(*)::bigint as count
      from drive_project_api_events e
      left join drive_projects p on p.id = e.project_id
      ${where}
      group by e.action
      order by count(*) desc
      limit 20;
    `,
    params
  )

  const byProject = await queryDb<{ project_id: string | null; name: string | null; count: string }>(
    `
      select p.project_id, p.name, count(*)::bigint as count
      from drive_project_api_events e
      left join drive_projects p on p.id = e.project_id
      ${where}
      group by p.project_id, p.name
      order by count(*) desc
      limit 20;
    `,
    params
  )

  const eventParams = [...params, limit + 1]
  const events = await queryDb<{
    id: string
    occurred_at: string
    action: string
    object_key: string | null
    status: number | null
    outcome: string
    ip_address: string | null
    user_agent: string | null
    request_id: string | null
    metadata: Record<string, unknown> | null
    project_id: string | null
    project_name: string | null
    key_name: string | null
    key_prefix: string | null
  }>(
    `
      select
        e.id, e.occurred_at, e.action, e.object_key, e.status, e.outcome,
        e.ip_address, e.user_agent, e.request_id, e.metadata,
        p.project_id, p.name as project_name,
        k.name as key_name, k.key_prefix
      from drive_project_api_events e
      left join drive_projects p on p.id = e.project_id
      left join drive_project_api_keys k on k.id = e.api_key_id
      ${where}
      order by e.occurred_at desc, e.id desc
      limit $${eventParams.length};
    `,
    eventParams
  )

  const pageRows = events.rows.slice(0, limit)
  const last = pageRows[pageRows.length - 1]
  return {
    summary: {
      total: Number(summary.rows[0]?.total ?? 0),
      success: Number(summary.rows[0]?.success ?? 0),
      failed: Number(summary.rows[0]?.failed ?? 0),
      rateLimited: Number(summary.rows[0]?.rate_limited ?? 0),
      uniqueKeys: Number(summary.rows[0]?.unique_keys ?? 0),
      uniqueProjects: Number(summary.rows[0]?.unique_projects ?? 0),
    },
    byAction: byAction.rows.map((row) => ({ action: row.action, count: Number(row.count) })),
    byProject: byProject.rows.map((row) => ({
      projectId: row.project_id ?? "unknown",
      name: row.name ?? "Unknown project",
      count: Number(row.count),
    })),
    events: pageRows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      action: row.action,
      objectKey: row.object_key ?? undefined,
      status: row.status ?? undefined,
      outcome: row.outcome,
      ipAddress: row.ip_address ?? undefined,
      userAgent: row.user_agent ?? undefined,
      requestId: row.request_id ?? undefined,
      metadata: row.metadata ?? undefined,
      projectId: row.project_id ?? undefined,
      projectName: row.project_name ?? undefined,
      keyName: row.key_name ?? undefined,
      keyPrefix: row.key_prefix ?? undefined,
    })),
    nextCursor: events.rows.length > limit && last ? `${last.occurred_at}|${last.id}` : null,
    generatedAt: new Date().toISOString(),
  }
}

export async function createProjectOperationJob(input: {
  projectIdentifier: string
  type: ProjectOperationType
  payload: Record<string, unknown>
  idempotencyKey?: string | null
}) {
  await ensureProjectOperationsSchema()
  const project = await getProjectByIdentifier(input.projectIdentifier)
  if (!project) throw new Error("Project not found")

  if (input.idempotencyKey) {
    const existing = await queryDb<JobRow>(
      `
        select * from drive_project_operation_jobs
        where project_id = $1 and idempotency_key = $2
        limit 1;
      `,
      [project.id, input.idempotencyKey]
    )
    if (existing.rows[0]) return mapJob(existing.rows[0])
  }

  const { rows } = await queryDb<JobRow>(
    `
      insert into drive_project_operation_jobs (project_id, type, payload, idempotency_key)
      values ($1, $2, $3::jsonb, $4)
      returning *;
    `,
    [project.id, input.type, JSON.stringify(input.payload), input.idempotencyKey ?? null]
  )
  return mapJob(rows[0])
}

export async function getProjectOperationJob(jobId: string) {
  await ensureProjectOperationsSchema()
  const { rows } = await queryDb<JobRow>(
    `select * from drive_project_operation_jobs where id = $1 limit 1`,
    [jobId]
  )
  return rows[0] ? mapJob(rows[0]) : null
}

async function setJobState(
  jobId: string,
  updates: Partial<Pick<ProjectOperationJob, "status" | "progress" | "result" | "error">> & {
    started?: boolean
    completed?: boolean
  }
) {
  const current = await getProjectOperationJob(jobId)
  const progress = updates.progress ?? current?.progress ?? {}
  const result = updates.result ?? current?.result ?? {}
  const { rows } = await queryDb<JobRow>(
    `
      update drive_project_operation_jobs
      set status = coalesce($2, status),
          progress = $3::jsonb,
          result = $4::jsonb,
          error = $5,
          started_at = case when $6::boolean and started_at is null then now() else started_at end,
          completed_at = case when $7::boolean then now() else completed_at end,
          updated_at = now()
      where id = $1
      returning *;
    `,
    [
      jobId,
      updates.status ?? null,
      JSON.stringify(progress),
      JSON.stringify(result),
      updates.error ?? current?.error ?? null,
      updates.started === true,
      updates.completed === true,
    ]
  )
  return mapJob(rows[0])
}

export async function processProjectOperationJob(jobId: string, maxPages = 250) {
  const job = await getProjectOperationJob(jobId)
  if (!job || job.status === "completed" || job.status === "failed") return job
  const project = await getProjectByIdentifier(job.projectId)
  if (!project) throw new Error("Project not found")
  const requestedBucketName = asString(job.payload.bucketName)
  const r2 = await getActiveProjectBucketR2Config(project, requestedBucketName)
  if ("response" in r2) {
    const data = await r2.response.json().catch(() => ({ error: "R2 unavailable" }))
    return setJobState(job.id, {
      status: "failed",
      error: String((data as { error?: unknown }).error ?? "R2 unavailable"),
      completed: true,
    })
  }

  await setJobState(job.id, { status: "running", started: true })

  try {
    if (job.type === "recursive_delete") {
      return await processRecursiveDelete(job, project, r2.config, r2.bucketName, maxPages)
    }
    if (job.type === "batch_delete") {
      return await processBatchDelete(job, project, r2.config, r2.bucketName)
    }
    if (job.type === "batch_copy" || job.type === "batch_move") {
      return await processBatchCopyMove(job, project, r2.config, r2.bucketName, job.type === "batch_move")
    }
    if (job.type === "prefix_rename") {
      return await processPrefixRename(job, project, r2.config, r2.bucketName, maxPages)
    }
    if (job.type === "inventory_scan") {
      return await processInventoryScan(job, project, r2.config, r2.bucketName, maxPages)
    }
    throw new Error(`Unsupported job type: ${job.type}`)
  } catch (error) {
    return setJobState(job.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Operation failed",
      completed: true,
    })
  }
}

async function processRecursiveDelete(
  job: ProjectOperationJob,
  project: Project,
  config: R2ClientConfig,
  bucketName: string,
  maxPages: number
) {
  const prefix = asString(job.payload.prefix || job.payload.key)
  if (!prefix) throw new Error("Prefix is required")
  let continuationToken = asString(job.progress.continuationToken) || undefined
  let deleted = Number(job.progress.deleted ?? 0)
  let pages = 0

  while (pages < maxPages) {
    const page = await r2ListObjectsPage(config, bucketName, {
      prefix,
      continuationToken,
      maxKeys: 1000,
    })
    const keys = (page.Contents ?? []).map((item) => item.Key).filter((key): key is string => Boolean(key))
    if (keys.length) {
      await r2DeleteObjects(config, bucketName, keys)
      deleted += keys.length
      await markTrackedBucketObjectsDeleted({ projectId: project.id, bucketName, keys })
    }
    continuationToken = page.NextContinuationToken
    pages += 1
    await setJobState(job.id, {
      status: continuationToken ? "running" : "completed",
        progress: { prefix, bucketName, continuationToken, deleted, pagesProcessed: pages },
        result: continuationToken ? {} : { deleted, bucketName },
        completed: !continuationToken,
      })
    if (!continuationToken) {
      return getProjectOperationJob(job.id)
    }
  }
  return getProjectOperationJob(job.id)
}

async function processBatchDelete(
  job: ProjectOperationJob,
  project: Project,
  config: R2ClientConfig,
  bucketName: string
) {
  const keys = asArray(job.payload.keys).map(String).filter(Boolean)
  await r2DeleteObjects(config, bucketName, keys)
  await markTrackedBucketObjectsDeleted({ projectId: project.id, bucketName, keys })
  return setJobState(job.id, {
    status: "completed",
    progress: { bucketName, processed: keys.length },
    result: { bucketName, deleted: keys.length },
    completed: true,
  })
}

async function processBatchCopyMove(
  job: ProjectOperationJob,
  project: Project,
  config: R2ClientConfig,
  bucketName: string,
  move: boolean
) {
  const items = asArray(job.payload.items) as Array<{ fromKey?: unknown; toKey?: unknown; ifMatch?: unknown }>
  let processed = 0
  for (const item of items) {
    const fromKey = asString(item.fromKey)
    const toKey = asString(item.toKey)
    if (!fromKey || !toKey) continue
    await r2CopyObject(config, bucketName, fromKey, toKey, {
      ifMatch: asString(item.ifMatch) || undefined,
    })
    if (move) {
      await r2DeleteObject(config, bucketName, fromKey)
      await syncRenamedTrackedBucketObject({
        config,
        bucketName,
        fromKey,
        toKey,
        projectId: project.id,
      }).catch(() => undefined)
    } else {
      await syncTrackedBucketObject({ config, bucketName, key: toKey, projectId: project.id }).catch(() => undefined)
    }
    processed += 1
  }
  return setJobState(job.id, {
    status: "completed",
    progress: { bucketName, processed },
    result: { bucketName, processed },
    completed: true,
  })
}

async function processPrefixRename(
  job: ProjectOperationJob,
  project: Project,
  config: R2ClientConfig,
  bucketName: string,
  maxPages: number
) {
  const fromPrefix = asString(job.payload.fromPrefix)
  const toPrefix = asString(job.payload.toPrefix)
  if (!fromPrefix || !toPrefix) throw new Error("fromPrefix and toPrefix are required")
  let continuationToken = asString(job.progress.continuationToken) || undefined
  let moved = Number(job.progress.moved ?? 0)
  let pages = 0

  while (pages < maxPages) {
    const page = await r2ListObjectsPage(config, bucketName, {
      prefix: fromPrefix,
      continuationToken,
      maxKeys: 1000,
    })
    const keys = (page.Contents ?? []).map((item) => item.Key).filter((key): key is string => Boolean(key))
    for (const fromKey of keys) {
      const toKey = `${toPrefix}${fromKey.slice(fromPrefix.length)}`
      await r2CopyObject(config, bucketName, fromKey, toKey)
      await r2DeleteObject(config, bucketName, fromKey)
      await syncRenamedTrackedBucketObject({
        config,
        bucketName,
        fromKey,
        toKey,
        projectId: project.id,
      }).catch(() => undefined)
      moved += 1
    }
    continuationToken = page.NextContinuationToken
    pages += 1
    await setJobState(job.id, {
      status: continuationToken ? "running" : "completed",
        progress: { fromPrefix, toPrefix, bucketName, continuationToken, moved, pagesProcessed: pages },
        result: continuationToken ? {} : { bucketName, moved },
        completed: !continuationToken,
      })
    if (!continuationToken) return getProjectOperationJob(job.id)
  }
  return getProjectOperationJob(job.id)
}

async function processInventoryScan(
  job: ProjectOperationJob,
  project: Project,
  config: R2ClientConfig,
  bucketName: string,
  maxPages: number
) {
  const prefix = asString(job.payload.prefix)
  let continuationToken = asString(job.progress.continuationToken) || undefined
  let indexed = Number(job.progress.indexed ?? 0)
  let pages = 0

  while (pages < maxPages) {
    const page = await r2ListObjectsPage(config, bucketName, {
      prefix: prefix || undefined,
      continuationToken,
      maxKeys: 1000,
    })
    const objects = page.Contents ?? []
    const inventoryObjects = objects
      .filter((object) => Boolean(object.Key))
      .map((object) => ({
        key: object.Key as string,
        size: object.Size ?? 0,
        etag: object.ETag,
        lastModified: object.LastModified?.toISOString(),
      }))
    await upsertProjectObjectInventoryBatch({
      projectId: project.id,
      bucketName,
      objects: inventoryObjects,
    })
    indexed += inventoryObjects.length
    continuationToken = page.NextContinuationToken
    pages += 1
    await setJobState(job.id, {
      status: continuationToken ? "running" : "completed",
      progress: { prefix, bucketName, continuationToken, indexed, pagesProcessed: pages },
      result: continuationToken ? {} : { bucketName, indexed },
      completed: !continuationToken,
    })
    if (!continuationToken) return getProjectOperationJob(job.id)
  }
  return getProjectOperationJob(job.id)
}
