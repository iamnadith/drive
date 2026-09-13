import crypto from "crypto"
import { ensureDriveSchema, isPostgresConfigured, queryDb, withDbTransaction } from "./db"

declare global {
  var __driveProjectAuthCache:
    | Map<string, { expiresAt: number; value: ValidatedProjectApiKey }>
    | undefined
  var __driveProjectAuthInflight:
    | Map<string, Promise<ValidatedProjectApiKey | null>>
    | undefined
  var __driveProjectLastUsedQueue: Map<string, number> | undefined
  var __driveProjectLastUsedTimer: ReturnType<typeof setTimeout> | undefined
  var __driveProjectLastUsedFlushInflight: Promise<void> | undefined
  var __driveProjectBucketAssignmentCache:
    | Map<string, { expiresAt: number; bucketNames: string[] }>
    | undefined
  var __driveProjectBucketAssignmentInflight: Map<string, Promise<string[]>> | undefined
}

export const PROJECT_PERMISSION_KEYS = [
  "list",
  "read",
  "download",
  "upload",
  "write",
  "rename",
  "delete",
  "createFolder",
  "createExpiringLink",
  "createPermanentLink",
  "revokeLink",
  "readMetadata",
  "writeMetadata",
] as const

export type ProjectPermission = (typeof PROJECT_PERMISSION_KEYS)[number]
export type ProjectPermissions = Record<ProjectPermission, boolean>
export type ProjectStatus = "active" | "disabled"
export type ProjectLinkMode = "expiring" | "permanent"

export type Project = {
  id: string
  projectId: string
  name: string
  bucketName: string
  status: ProjectStatus
  createdAccountId?: string
  createdAccountLabel?: string
  createdAt: string
  updatedAt: string
  keyCount?: number
  bucketCount?: number
}

export type ProjectBucketAssignment = {
  accountId?: string
  bucketName: string
  isPrimary: boolean
  createdAt: string
  projectCount: number
}

export type ProjectApiKey = {
  id: string
  name: string
  keyPrefix: string
  status: ProjectStatus
  expiresAt?: string
  lastUsedAt?: string
  permissions: ProjectPermissions
  createdAt: string
  updatedAt: string
}

export type ProjectFileLink = {
  id: string
  projectId: string
  fileId?: string
  objectKey: string
  bucketName?: string
  mode: ProjectLinkMode
  expiresAt?: string
  revokedAt?: string
  createdAt: string
}

export type ValidatedProjectApiKey = {
  apiKey: {
    id: string
    name: string
    keyPrefix: string
  }
  projects: Array<{
    project: Project
    permissions: ProjectPermissions
  }>
}

type ProjectRow = {
  id: string
  project_id: string
  name: string
  bucket_name: string
  status: ProjectStatus
  created_account_id: string | null
  created_account_label: string | null
  created_at: string
  updated_at: string
  key_count?: string | number | null
  bucket_count?: string | number | null
}

type ProjectBucketAssignmentRow = {
  account_id?: string | null
  bucket_name: string
  is_primary: boolean
  created_at: string
  project_count?: string | number | null
}

type ApiKeyRow = {
  id: string
  name: string
  key_prefix: string
  status: ProjectStatus
  expires_at: string | null
  last_used_at: string | null
  permissions: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

type FileLinkRow = {
  id: string
  project_id: string
  file_id: string | null
  object_key: string
  bucket_name: string | null
  mode: ProjectLinkMode
  expires_at: string | null
  revoked_at: string | null
  created_at: string
}

export const EMPTY_PROJECT_PERMISSIONS: ProjectPermissions = Object.fromEntries(
  PROJECT_PERMISSION_KEYS.map((key) => [key, false])
) as ProjectPermissions

export const PROJECT_PERMISSION_PRESETS: Record<string, ProjectPermissions> = {
  "Read only": {
    ...EMPTY_PROJECT_PERMISSIONS,
    list: true,
    read: true,
    download: true,
    readMetadata: true,
  },
  "Upload only": {
    ...EMPTY_PROJECT_PERMISSIONS,
    upload: true,
    createFolder: true,
    writeMetadata: true,
  },
  "Read + write": {
    ...EMPTY_PROJECT_PERMISSIONS,
    list: true,
    read: true,
    download: true,
    upload: true,
    write: true,
    createFolder: true,
    readMetadata: true,
    writeMetadata: true,
    createExpiringLink: true,
  },
  "Full access": Object.fromEntries(
    PROJECT_PERMISSION_KEYS.map((key) => [key, true])
  ) as ProjectPermissions,
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    bucketName: row.bucket_name,
    status: row.status,
    createdAccountId: row.created_account_id ?? undefined,
    createdAccountLabel: row.created_account_label ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    keyCount:
      row.key_count === null || row.key_count === undefined
        ? undefined
        : Number(row.key_count),
    bucketCount:
      row.bucket_count === null || row.bucket_count === undefined
        ? undefined
        : Number(row.bucket_count),
  }
}

function mapProjectBucketAssignment(row: ProjectBucketAssignmentRow): ProjectBucketAssignment {
  return {
    accountId: row.account_id ?? undefined,
    bucketName: row.bucket_name,
    isPrimary: row.is_primary === true,
    createdAt: row.created_at,
    projectCount: Number(row.project_count ?? 1),
  }
}

function mapApiKey(row: ApiKeyRow): ProjectApiKey {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    status: row.status,
    expiresAt: row.expires_at ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined,
    permissions: normalizePermissions(row.permissions),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapFileLink(row: FileLinkRow): ProjectFileLink {
  return {
    id: row.id,
    projectId: row.project_id,
    fileId: row.file_id ?? undefined,
    objectKey: row.object_key,
    bucketName: row.bucket_name ?? undefined,
    mode: row.mode,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    createdAt: row.created_at,
  }
}

export function normalizePermissions(value: unknown): ProjectPermissions {
  const input =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return Object.fromEntries(
    PROJECT_PERMISSION_KEYS.map((key) => [key, input[key] === true])
  ) as ProjectPermissions
}

export function hasProjectPermission(
  permissions: ProjectPermissions,
  permission: ProjectPermission
) {
  return permissions[permission] === true
}

export function hashProjectSecret(secret: string) {
  const pepper = process.env.PROJECT_API_KEY_PEPPER ?? ""
  return crypto.createHash("sha256").update(`${pepper}:${secret}`).digest("hex")
}

function getAuthCacheTtlMs() {
  const raw = Number(process.env.PROJECT_API_AUTH_CACHE_TTL_SECONDS ?? 60)
  return Math.max(5, Math.min(300, Number.isFinite(raw) ? raw : 60)) * 1000
}

function getAuthCache() {
  if (!global.__driveProjectAuthCache) {
    global.__driveProjectAuthCache = new Map()
  }
  return global.__driveProjectAuthCache
}

function getAuthInflight() {
  if (!global.__driveProjectAuthInflight) {
    global.__driveProjectAuthInflight = new Map()
  }
  return global.__driveProjectAuthInflight
}

function getLastUsedQueue() {
  if (!global.__driveProjectLastUsedQueue) {
    global.__driveProjectLastUsedQueue = new Map()
  }
  return global.__driveProjectLastUsedQueue
}

function scheduleLastUsedFlush(apiKeyId: string) {
  const queue = getLastUsedQueue()
  queue.set(apiKeyId, Date.now())
  if (global.__driveProjectLastUsedTimer) return

  global.__driveProjectLastUsedTimer = setTimeout(() => {
    global.__driveProjectLastUsedTimer = undefined
    void flushProjectApiKeyLastUsed()
  }, 10_000)
  global.__driveProjectLastUsedTimer.unref?.()
}

export async function flushProjectApiKeyLastUsed() {
  if (global.__driveProjectLastUsedFlushInflight) {
    return global.__driveProjectLastUsedFlushInflight
  }

  const queue = getLastUsedQueue()
  const ids = Array.from(queue.keys())
  queue.clear()
  if (ids.length === 0) return

  const flush = (async () => {
    try {
      await ensureProjectSchema()
      await queryDb(
        `
          update drive_project_api_keys
          set last_used_at = now()
          where id = any($1::uuid[]);
        `,
        [ids]
      )
    } catch (error) {
      // Keep the bookkeeping best-effort without losing the queued IDs. A
      // transient database timeout must not make every hot API request log an
      // avoidable error or create overlapping retry storms.
      const retryQueue = getLastUsedQueue()
      for (const id of ids) retryQueue.set(id, Date.now())
      console.warn("Unable to flush project API key last_used_at; retrying later:", error)
      if (!global.__driveProjectLastUsedTimer) {
        global.__driveProjectLastUsedTimer = setTimeout(() => {
          global.__driveProjectLastUsedTimer = undefined
          void flushProjectApiKeyLastUsed()
        }, 30_000)
        global.__driveProjectLastUsedTimer.unref?.()
      }
    }
  })()
  global.__driveProjectLastUsedFlushInflight = flush
  try {
    await flush
  } finally {
    if (global.__driveProjectLastUsedFlushInflight === flush) {
      global.__driveProjectLastUsedFlushInflight = undefined
    }
  }
}

export function clearProjectAuthCache() {
  getAuthCache().clear()
  global.__driveProjectBucketAssignmentCache?.clear()
  global.__driveProjectBucketAssignmentInflight?.clear()
}

export function generateProjectId() {
  return crypto.randomBytes(9).toString("base64url").toLowerCase()
}

export function generateProjectApiKey() {
  return crypto.randomBytes(32).toString("base64url")
}

export function generateFileLinkToken() {
  return `pfl_${crypto.randomBytes(32).toString("base64url")}`
}

export function sanitizeBucketName(name: string) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "")
  return base || "project"
}

export async function ensureProjectSchema() {
  await ensureDriveSchema()
}
export async function listProjects(): Promise<Project[]> {
  await ensureProjectSchema()
  const { rows } = await queryDb<ProjectRow>(`
    select p.*,
      count(distinct a.id)::int as key_count,
      count(distinct b.bucket_name)::int as bucket_count
    from drive_projects p
    left join drive_project_api_key_assignments a on a.project_id = p.id
    left join drive_project_bucket_assignments b on b.project_id = p.id
    group by p.id
    order by p.created_at desc;
  `)
  return rows.map(mapProject)
}

export async function getProjectByIdentifier(identifier: string): Promise<Project | null> {
  await ensureProjectSchema()
  const { rows } = await queryDb<ProjectRow>(
    `
      select * from drive_projects
      where id::text = $1 or project_id = $1
      limit 1;
    `,
    [identifier]
  )
  return rows[0] ? mapProject(rows[0]) : null
}

export async function createProjectRecord(input: {
  name: string
  projectId: string
  bucketName?: string
  createdAccountId?: string
  createdAccountLabel?: string
}) {
  await ensureProjectSchema()
  const { rows } = await queryDb<ProjectRow>(
    `
      insert into drive_projects
        (project_id, name, bucket_name, created_account_id, created_account_label)
      values ($1, $2, $3, $4, $5)
      returning *;
    `,
    [
      input.projectId,
      input.name.trim(),
      input.bucketName ?? "",
      input.createdAccountId ?? null,
      input.createdAccountLabel ?? null,
    ]
  )
  return mapProject(rows[0])
}

export async function updateProjectRecord(
  identifier: string,
  updates: { name?: string; status?: ProjectStatus; bucketName?: string }
) {
  await ensureProjectSchema()
  const current = await getProjectByIdentifier(identifier)
  if (!current) throw new Error("Project not found")
  const nextName = updates.name?.trim()
  const { rows } = await queryDb<ProjectRow>(
    `
      update drive_projects
      set
        name = coalesce($2, name),
        status = coalesce($3, status),
        bucket_name = coalesce($4, bucket_name),
        updated_at = now()
      where id = $1
      returning *;
    `,
    [current.id, nextName || null, updates.status ?? null, updates.bucketName ?? null]
  )
  clearProjectAuthCache()
  return mapProject(rows[0])
}

export async function deleteProjectRecord(identifier: string) {
  await ensureProjectSchema()
  const project = await getProjectByIdentifier(identifier)
  if (!project) return null
  await queryDb(`delete from drive_projects where id = $1`, [project.id])
  await deleteOrphanApiKeys()
  clearProjectAuthCache()
  return project
}

export async function listProjectBuckets(projectIdentifier: string) {
  await ensureProjectSchema()
  const project = await getProjectByIdentifier(projectIdentifier)
  if (!project) throw new Error("Project not found")
  return listProjectBucketsById(project.id)
}

export async function listProjectBucketsById(projectId: string) {
  await ensureProjectSchema()
  const { rows } = await queryDb<ProjectBucketAssignmentRow>(
    `
      select a.account_id, a.bucket_name, a.is_primary, a.created_at,
        (select count(*) from drive_project_bucket_assignments shared where shared.account_id = a.account_id and shared.bucket_name = a.bucket_name)::int as project_count
      from drive_project_bucket_assignments a
      where a.project_id = $1
      order by a.is_primary desc, a.created_at asc, a.bucket_name asc;
    `,
    [projectId]
  )
  return rows.map(mapProjectBucketAssignment)
}

export async function getProjectBucketManagementData(identifier: string) {
  await ensureProjectSchema()
  const { rows } = await queryDb<ProjectRow & {
    active_account_id: string | null
    active_account_cloudflare_id: string | null
    active_account_last_synced_at: string | null
    assigned_buckets: unknown
    available_buckets: unknown
  }>(`
    select p.*,
      active.id active_account_id,
      active.cloudflare_account_id active_account_cloudflare_id,
      active.last_synced_at active_account_last_synced_at,
      coalesce(assigned.buckets, '[]'::jsonb) assigned_buckets,
      coalesce(available.buckets, '[]'::jsonb) available_buckets
    from drive_projects p
    left join lateral (
      select id,cloudflare_account_id,last_synced_at
      from drive_accounts
      where status='active'
      order by updated_at desc nulls last,created_at desc,id desc
      limit 1
    ) active on true
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'accountId',a.account_id,
        'bucketName',a.bucket_name,
        'isPrimary',a.is_primary,
        'createdAt',a.created_at,
        'projectCount',(
          select count(*)::int from drive_project_bucket_assignments shared
          where shared.account_id=a.account_id and shared.bucket_name=a.bucket_name
        )
      ) order by a.is_primary desc,a.created_at asc,a.bucket_name asc) buckets
      from drive_project_bucket_assignments a
      where a.project_id=p.id
    ) assigned on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('id',s.bucket_name,'name',s.bucket_name) order by s.bucket_name) buckets
      from drive_bucket_stats s
      where s.account_id=active.id
    ) available on true
    where p.id::text=$1 or p.project_id=$1
    limit 1
  `, [identifier])
  const row = rows[0]
  if (!row) return null
  return {
    project: mapProject(row),
    buckets: Array.isArray(row.assigned_buckets)
      ? row.assigned_buckets.map((bucket) => mapProjectBucketAssignment({
          account_id: typeof bucket.accountId === "string" ? bucket.accountId : null,
          bucket_name: String(bucket.bucketName ?? ""),
          is_primary: bucket.isPrimary === true,
          created_at: String(bucket.createdAt ?? ""),
          project_count: Number(bucket.projectCount ?? 1),
        }))
      : [],
    availableBuckets: Array.isArray(row.available_buckets)
      ? row.available_buckets.flatMap((bucket) => {
          if (!bucket || typeof bucket !== "object") return []
          const name = (bucket as Record<string, unknown>).name
          if (typeof name !== "string") return []
          return [{ id: name, name }]
        })
      : [],
    activeAccount: row.active_account_id
      ? {
          id: row.active_account_id,
          cloudflareAccountId: row.active_account_cloudflare_id,
          lastSyncedAt: row.active_account_last_synced_at,
        }
      : null,
  }
}

export async function getProjectBucketAssignment(
  projectIdentifier: string,
  bucketName: string
): Promise<ProjectBucketAssignment | null> {
  await ensureProjectSchema()
  const project = await getProjectByIdentifier(projectIdentifier)
  if (!project) throw new Error("Project not found")
  const { rows } = await queryDb<ProjectBucketAssignmentRow>(
    `
      select a.account_id, a.bucket_name, a.is_primary, a.created_at,
        (select count(*) from drive_project_bucket_assignments shared where shared.account_id = a.account_id and shared.bucket_name = a.bucket_name)::int as project_count
      from drive_project_bucket_assignments a
      where a.project_id = $1 and a.bucket_name = $2
      limit 1;
    `,
    [project.id, bucketName]
  )
  return rows[0] ? mapProjectBucketAssignment(rows[0]) : null
}

export async function getAssignedProjectIdsForBucket(accountId: string, bucketName: string): Promise<string[]> {
  await ensureProjectSchema()
  if (!isPostgresConfigured()) return []
  const { rows } = await queryDb<{ project_id: string }>(
    `
      select assignment.project_id
      from drive_project_bucket_assignments assignment
      join drive_projects project on project.id = assignment.project_id
      where assignment.account_id = $1 and assignment.bucket_name = $2 and project.status = 'active'
      order by assignment.created_at asc, assignment.project_id asc
    `,
    [accountId, bucketName]
  )
  return rows.map((row) => row.project_id)
}

export async function listAssignedProjectsForBuckets(accountId: string, bucketNames: string[]) {
  await ensureProjectSchema()
  const names = Array.from(new Set(bucketNames.filter(Boolean)))
  const projects = new Map<string, Project[]>()
  if (!isPostgresConfigured() || names.length === 0) return projects
  const { rows } = await queryDb<ProjectRow & { assigned_bucket_name: string }>(
    `
      select p.*, a.bucket_name as assigned_bucket_name
      from drive_project_bucket_assignments a
      join drive_projects p on p.id = a.project_id
      where a.account_id = $1 and a.bucket_name = any($2::text[]);
    `,
    [accountId, names]
  )
  for (const row of rows) {
    const bucketProjects = projects.get(row.assigned_bucket_name) ?? []
    bucketProjects.push(mapProject(row))
    projects.set(row.assigned_bucket_name, bucketProjects)
  }
  return projects
}

export async function assignProjectBucket(input: {
  projectIdentifier: string
  accountId: string
  bucketName: string
  makePrimary?: boolean
}) {
  await ensureProjectSchema()
  const project = await getProjectByIdentifier(input.projectIdentifier)
  if (!project) throw new Error("Project not found")
  if (project.createdAccountId && project.createdAccountId !== input.accountId) {
    throw new Error("Project belongs to a different Cloudflare account")
  }

  const currentBuckets = await listProjectBuckets(project.id)
  const makePrimary = input.makePrimary === true || currentBuckets.length === 0

  await withDbTransaction(async (client) => {
    await client.query(
      `
        insert into drive_project_bucket_assignments (project_id, account_id, bucket_name, is_primary)
        values ($1, $2, $3, false)
        on conflict (project_id, bucket_name)
        do update set account_id = excluded.account_id;
      `,
      [project.id, input.accountId, input.bucketName]
    )
    if (makePrimary) {
      await client.query(`update drive_project_bucket_assignments set is_primary = false where project_id = $1;`, [project.id])
      await client.query(
        `update drive_project_bucket_assignments set is_primary = true where project_id = $1 and bucket_name = $2;`,
        [project.id, input.bucketName]
      )
    }
    const { rows } = await client.query<{ bucket_name: string }>(
      `select bucket_name from drive_project_bucket_assignments where project_id = $1 order by is_primary desc, created_at asc, bucket_name asc limit 1;`,
      [project.id]
    )
    await client.query(`update drive_projects set bucket_name = $2, updated_at = now() where id = $1;`, [project.id, rows[0]?.bucket_name ?? ""])
  })
  clearProjectAuthCache()
  return listProjectBuckets(project.id)
}

export async function setProjectPrimaryBucket(projectIdentifier: string, bucketName: string) {
  await ensureProjectSchema()
  const project = await getProjectByIdentifier(projectIdentifier)
  if (!project) throw new Error("Project not found")

  await withDbTransaction(async (client) => {
    const target = await client.query(
      `select 1 from drive_project_bucket_assignments where project_id = $1 and bucket_name = $2 for update;`,
      [project.id, bucketName]
    )
    if (!target.rowCount) throw new Error("Bucket is not assigned to this project")
    await client.query(`update drive_project_bucket_assignments set is_primary = false where project_id = $1;`, [project.id])
    await client.query(`update drive_project_bucket_assignments set is_primary = true where project_id = $1 and bucket_name = $2;`, [project.id, bucketName])
    await client.query(`update drive_projects set bucket_name = $2, updated_at = now() where id = $1;`, [project.id, bucketName])
  })
  clearProjectAuthCache()
  return listProjectBuckets(project.id)
}

export async function removeProjectBucket(projectIdentifier: string, bucketName: string) {
  await ensureProjectSchema()
  const project = await getProjectByIdentifier(projectIdentifier)
  if (!project) throw new Error("Project not found")

  await withDbTransaction(async (client) => {
    const { rows: targetRows } = await client.query<{ is_primary: boolean }>(
      `select is_primary from drive_project_bucket_assignments where project_id = $1 and bucket_name = $2 for update;`,
      [project.id, bucketName]
    )
    if (!targetRows[0]) throw new Error("Bucket is not assigned to this project")
    await client.query(`delete from drive_project_bucket_assignments where project_id = $1 and bucket_name = $2;`, [project.id, bucketName])
    if (targetRows[0].is_primary) {
      const { rows } = await client.query<{ bucket_name: string }>(
        `select bucket_name from drive_project_bucket_assignments where project_id = $1 order by created_at asc, bucket_name asc limit 1;`,
        [project.id]
      )
      if (rows[0]) {
        await client.query(`update drive_project_bucket_assignments set is_primary = true where project_id = $1 and bucket_name = $2;`, [project.id, rows[0].bucket_name])
      }
    }
    const { rows } = await client.query<{ bucket_name: string }>(
      `select bucket_name from drive_project_bucket_assignments where project_id = $1 order by is_primary desc, created_at asc, bucket_name asc limit 1;`,
      [project.id]
    )
    await client.query(`update drive_projects set bucket_name = $2, updated_at = now() where id = $1;`, [project.id, rows[0]?.bucket_name ?? ""])
  })
  clearProjectAuthCache()
  return listProjectBuckets(project.id)
}

export async function listProjectsUsingBucket(accountId: string, bucketName: string) {
  await ensureProjectSchema()
  const { rows } = await queryDb<ProjectRow>(
    `select p.* from drive_projects p join drive_project_bucket_assignments a on a.project_id = p.id where a.account_id = $1 and a.bucket_name = $2`,
    [accountId, bucketName]
  )
  return rows.map(mapProject)
}

export async function listProjectApiKeys(projectIdentifier: string) {
  await ensureProjectSchema()
  const project = await getProjectByIdentifier(projectIdentifier)
  if (!project) throw new Error("Project not found")
  const { rows } = await queryDb<ApiKeyRow>(
    `
      select k.*, a.permissions
      from drive_project_api_key_assignments a
      join drive_project_api_keys k on k.id = a.api_key_id
      where a.project_id = $1
      order by k.created_at desc;
    `,
    [project.id]
  )
  return rows.map(mapApiKey)
}

export async function createProjectApiKey(input: {
  projectIdentifier: string
  name: string
  permissions: ProjectPermissions
  expiresAt?: string | null
}) {
  await ensureProjectSchema()
  const project = await getProjectByIdentifier(input.projectIdentifier)
  if (!project) throw new Error("Project not found")

  const secret = generateProjectApiKey()
  const keyPrefix = secret.slice(0, 14)
  const keyHash = hashProjectSecret(secret)
  const name = input.name.trim() || "API key"
  const permissions = normalizePermissions(input.permissions)

  const { rows } = await queryDb<ApiKeyRow>(
    `
      with inserted_key as (
        insert into drive_project_api_keys (name, key_prefix, key_hash, expires_at)
        values ($1, $2, $3, $4)
        returning *
      ),
      inserted_assignment as (
        insert into drive_project_api_key_assignments (project_id, api_key_id, permissions)
        select $5, id, $6::jsonb from inserted_key
      )
      select inserted_key.*, $6::jsonb as permissions
      from inserted_key;
    `,
    [name, keyPrefix, keyHash, input.expiresAt ?? null, project.id, JSON.stringify(permissions)]
  )
  clearProjectAuthCache()

  return { apiKey: mapApiKey(rows[0]), secret }
}

export async function updateProjectApiKey(
  projectIdentifier: string,
  keyId: string,
  updates: {
    name?: string
    status?: ProjectStatus
    expiresAt?: string | null
    permissions?: ProjectPermissions
  }
) {
  await ensureProjectSchema()
  const project = await getProjectByIdentifier(projectIdentifier)
  if (!project) throw new Error("Project not found")

  const existing = await queryDb<ApiKeyRow>(
    `
      select k.*, a.permissions
      from drive_project_api_key_assignments a
      join drive_project_api_keys k on k.id = a.api_key_id
      where a.project_id = $1 and k.id = $2
      limit 1;
    `,
    [project.id, keyId]
  )
  if (!existing.rows[0]) throw new Error("API key not found")

  const name = updates.name?.trim()
  const { rows } = await queryDb<ApiKeyRow>(
    `
      update drive_project_api_keys
      set
        name = coalesce($2, name),
        status = coalesce($3, status),
        expires_at = case when $4::boolean then $5::timestamptz else expires_at end,
        updated_at = now()
      where id = $1
      returning *;
    `,
    [
      keyId,
      name || null,
      updates.status ?? null,
      updates.expiresAt !== undefined,
      updates.expiresAt ?? null,
    ]
  )

  if (updates.permissions) {
    await queryDb(
      `
        update drive_project_api_key_assignments
        set permissions = $3::jsonb, updated_at = now()
        where project_id = $1 and api_key_id = $2;
      `,
      [project.id, keyId, JSON.stringify(normalizePermissions(updates.permissions))]
    )
  }

  clearProjectAuthCache()
  const permissions = updates.permissions
    ? normalizePermissions(updates.permissions)
    : normalizePermissions(existing.rows[0].permissions)
  return mapApiKey({ ...rows[0], permissions })
}

export async function deleteProjectApiKey(projectIdentifier: string, keyId: string) {
  await ensureProjectSchema()
  const project = await getProjectByIdentifier(projectIdentifier)
  if (!project) throw new Error("Project not found")
  await queryDb(
    `delete from drive_project_api_key_assignments where project_id = $1 and api_key_id = $2`,
    [project.id, keyId]
  )
  await deleteOrphanApiKeys()
  clearProjectAuthCache()
}

async function deleteOrphanApiKeys() {
  await queryDb(`
    delete from drive_project_api_keys k
    where not exists (
      select 1 from drive_project_api_key_assignments a where a.api_key_id = k.id
    );
  `)
}

async function loadProjectApiKeyFromDb(keyHash: string): Promise<ValidatedProjectApiKey | null> {
  await ensureProjectSchema()
  const { rows } = await queryDb<
    ApiKeyRow & {
      api_key_id: string
      api_key_name: string
      project_uuid: string
      project_id: string
      name: string
      bucket_name: string
      project_status: ProjectStatus
      created_account_id: string | null
      created_account_label: string | null
      project_created_at: string
      project_updated_at: string
      permissions: Record<string, unknown>
    }
  >(
    `
      select
        k.id as api_key_id,
        k.name as api_key_name,
        k.key_prefix,
        k.status,
        k.expires_at,
        k.last_used_at,
        k.created_at,
        k.updated_at,
        a.permissions,
        p.id as project_uuid,
        p.project_id,
        p.name,
        p.bucket_name,
        p.status as project_status,
        p.created_account_id,
        p.created_account_label,
        p.created_at as project_created_at,
        p.updated_at as project_updated_at
      from drive_project_api_keys k
      join drive_project_api_key_assignments a on a.api_key_id = k.id
      join drive_projects p on p.id = a.project_id
      where k.key_hash = $1
        and k.status = 'active'
        and (k.expires_at is null or k.expires_at > now());
    `,
    [keyHash]
  )

  if (rows.length === 0) return null

  return {
    apiKey: {
      id: rows[0].api_key_id,
      name: rows[0].api_key_name,
      keyPrefix: rows[0].key_prefix,
    },
    projects: rows
      .filter((row) => row.project_status === "active")
      .map((row) => ({
        project: mapProject({
          id: row.project_uuid,
          project_id: row.project_id,
          name: row.name,
          bucket_name: row.bucket_name,
          status: row.project_status as ProjectStatus,
          created_account_id: row.created_account_id,
          created_account_label: row.created_account_label,
          created_at: row.project_created_at,
          updated_at: row.project_updated_at,
        }),
        permissions: normalizePermissions(row.permissions),
      })),
  }
}

export async function validateProjectApiKey(secret: string) {
  const keyHash = hashProjectSecret(secret)
  const cache = getAuthCache()
  const cached = cache.get(keyHash)
  if (cached && cached.expiresAt > Date.now()) {
    scheduleLastUsedFlush(cached.value.apiKey.id)
    return cached.value
  }

  // A burst of HEAD probes (for example, a registration readiness scan) can
  // otherwise open one database lookup per request before the first result is
  // cached. Share the cold lookup so all requests await the same query.
  const inflight = getAuthInflight()
  const pending = inflight.get(keyHash)
  if (pending) return pending

  const lookup = (async () => {
    const loaded = await loadProjectApiKeyFromDb(keyHash)
    if (!loaded) {
      cache.delete(keyHash)
      return null
    }

    cache.set(keyHash, {
      expiresAt: Date.now() + getAuthCacheTtlMs(),
      value: loaded,
    })
    scheduleLastUsedFlush(loaded.apiKey.id)
    return loaded
  })()
  inflight.set(keyHash, lookup)
  try {
    return await lookup
  } finally {
    if (inflight.get(keyHash) === lookup) inflight.delete(keyHash)
  }
}

export async function authorizeProjectApiKey(
  secret: string,
  projectId: string,
  permission: ProjectPermission
) {
  const result = await validateProjectApiKey(secret)
  if (!result) return { error: "Invalid API key" as const, status: 401 as const }
  const assignment = result.projects.find((item) => item.project.projectId === projectId)
  if (!assignment) {
    return { error: "API key is not assigned to this project" as const, status: 403 as const }
  }
  if (!hasProjectPermission(assignment.permissions, permission)) {
    return { error: `API key is missing '${permission}' permission` as const, status: 403 as const }
  }
  return { ...result, project: assignment.project, permissions: assignment.permissions }
}

export async function createProjectFileLink(input: {
  projectIdentifier: string
  fileId?: string | null
  objectKey: string
  bucketName: string
  mode: ProjectLinkMode
  expiresAt?: string | null
}) {
  await ensureProjectSchema()
  const project = await getProjectByIdentifier(input.projectIdentifier)
  if (!project) throw new Error("Project not found")
  const token = generateFileLinkToken()
  const { rows } = await queryDb<FileLinkRow>(
    `
      insert into drive_project_file_links
        (project_id, file_id, object_key, bucket_name, token_hash, mode, expires_at)
      values ($1, $2, $3, $4, $5, $6, $7)
      returning *;
    `,
    [
      project.id,
      input.fileId ?? null,
      input.objectKey,
      input.bucketName,
      hashProjectSecret(token),
      input.mode,
      input.expiresAt ?? null,
    ]
  )
  return { link: mapFileLink(rows[0]), token, project }
}

export async function getProjectFileLinkByToken(token: string) {
  await ensureProjectSchema()
  const { rows } = await queryDb<
    FileLinkRow & {
      project_uuid: string
      external_project_id: string
      project_name: string
      bucket_name: string
      project_status: ProjectStatus
      created_account_id: string | null
      created_account_label: string | null
      project_created_at: string
      project_updated_at: string
    }
  >(
    `
      select
        l.*,
        p.id as project_uuid,
        p.project_id as external_project_id,
        p.name as project_name,
        coalesce(l.bucket_name, p.bucket_name) as bucket_name,
        p.status as project_status,
        p.created_account_id,
        p.created_account_label,
        p.created_at as project_created_at,
        p.updated_at as project_updated_at
      from drive_project_file_links l
      join drive_projects p on p.id = l.project_id
      where l.token_hash = $1
        and l.mode = 'permanent'
        and l.revoked_at is null
        and (l.expires_at is null or l.expires_at > now())
        and p.status = 'active'
      limit 1;
    `,
    [hashProjectSecret(token)]
  )
  const row = rows[0]
  if (!row) return null
  return {
    link: mapFileLink(row),
    project: mapProject({
      id: row.project_uuid,
      project_id: row.external_project_id,
      name: row.project_name,
      bucket_name: row.bucket_name,
      status: row.project_status,
      created_account_id: row.created_account_id,
      created_account_label: row.created_account_label,
      created_at: row.project_created_at,
      updated_at: row.project_updated_at,
    }),
  }
}

export async function revokeProjectFileLink(projectIdentifier: string, linkId: string) {
  await ensureProjectSchema()
  const project = await getProjectByIdentifier(projectIdentifier)
  if (!project) throw new Error("Project not found")
  const { rows } = await queryDb<FileLinkRow>(
    `
      update drive_project_file_links
      set revoked_at = now()
      where id = $1 and project_id = $2
      returning *;
    `,
    [linkId, project.id]
  )
  if (!rows[0]) throw new Error("Link not found")
  return mapFileLink(rows[0])
}
