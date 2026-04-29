import crypto from "crypto"
import { isPostgresConfigured, queryDb } from "./db"

declare global {
  var __driveProjectAuthCache:
    | Map<string, { expiresAt: number; value: ValidatedProjectApiKey }>
    | undefined
  var __driveProjectLastUsedQueue: Map<string, number> | undefined
  var __driveProjectLastUsedTimer: ReturnType<typeof setTimeout> | undefined
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
  objectKey: string
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
  object_key: string
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
    objectKey: row.object_key,
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
  const queue = getLastUsedQueue()
  const ids = Array.from(queue.keys())
  queue.clear()
  if (ids.length === 0) return
  await ensureProjectSchema()
  await queryDb(
    `
      update drive_project_api_keys
      set last_used_at = now()
      where id = any($1::uuid[]);
    `,
    [ids]
  ).catch((error) => {
    console.error("Unable to flush project API key last_used_at:", error)
  })
}

export function clearProjectAuthCache() {
  getAuthCache().clear()
}

export function generateProjectId() {
  return `prj_${crypto.randomBytes(9).toString("base64url").toLowerCase()}`
}

export function generateProjectApiKey() {
  return `drv_${crypto.randomBytes(32).toString("base64url")}`
}

export function generateFileLinkToken() {
  return `pfl_${crypto.randomBytes(32).toString("base64url")}`
}

export function sanitizeBucketName(name: string, projectId: string) {
  const suffix = projectId.replace(/^prj_/, "").slice(0, 12)
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 45)
    .replace(/^-+|-+$/g, "")
  return `${base || "project"}-${suffix}`
}

export async function ensureProjectSchema() {
  if (!isPostgresConfigured()) return

  await queryDb(`create extension if not exists pgcrypto;`)
  await queryDb(`
    create table if not exists drive_projects (
      id uuid primary key default gen_random_uuid(),
      project_id text not null,
      name text not null,
      bucket_name text not null,
      status text not null default 'active',
      created_account_id uuid references drive_accounts(id) on delete set null,
      created_account_label text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `)
  await queryDb(`
    do $$
    declare
      id_data_type text;
      pk_name text;
    begin
      select c.data_type
      into id_data_type
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'drive_projects'
        and c.column_name = 'id';

      if id_data_type is not null and id_data_type <> 'uuid' then
        alter table public.drive_projects add column if not exists legacy_id text;

        update public.drive_projects
        set legacy_id = id::text
        where legacy_id is null;

        select conname
        into pk_name
        from pg_constraint
        where conrelid = 'public.drive_projects'::regclass
          and contype = 'p'
        limit 1;

        if pk_name is not null then
          execute format('alter table public.drive_projects drop constraint %I', pk_name);
        end if;

        alter table public.drive_projects rename column id to old_text_id;
        alter table public.drive_projects add column id uuid default gen_random_uuid();

        update public.drive_projects
        set id = case
          when old_text_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then old_text_id::text::uuid
          else gen_random_uuid()
        end;

        alter table public.drive_projects alter column id set not null;
        alter table public.drive_projects add primary key (id);
      end if;
    end $$;
  `)
  await queryDb(`create unique index if not exists drive_projects_project_id_key on drive_projects (project_id);`)
  await queryDb(`create unique index if not exists drive_projects_bucket_name_key on drive_projects (bucket_name);`)
  await queryDb(`create index if not exists drive_projects_status_idx on drive_projects (status);`)

  await queryDb(`
    create table if not exists drive_project_api_keys (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      key_prefix text not null,
      key_hash text not null,
      status text not null default 'active',
      expires_at timestamptz,
      last_used_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `)
  await queryDb(`create unique index if not exists drive_project_api_keys_hash_key on drive_project_api_keys (key_hash);`)
  await queryDb(`create index if not exists drive_project_api_keys_status_idx on drive_project_api_keys (status);`)

  await queryDb(`
    create table if not exists drive_project_api_key_assignments (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references drive_projects(id) on delete cascade,
      api_key_id uuid not null references drive_project_api_keys(id) on delete cascade,
      permissions jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `)
  await queryDb(`
    create unique index if not exists drive_project_api_key_assignments_unique
      on drive_project_api_key_assignments (project_id, api_key_id);
  `)
  await queryDb(`create index if not exists drive_project_api_key_assignments_key_idx on drive_project_api_key_assignments (api_key_id);`)

  await queryDb(`
    create table if not exists drive_project_file_links (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references drive_projects(id) on delete cascade,
      object_key text not null,
      token_hash text not null,
      mode text not null,
      expires_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz not null default now()
    );
  `)
  await queryDb(`create unique index if not exists drive_project_file_links_token_hash_key on drive_project_file_links (token_hash);`)
  await queryDb(`create index if not exists drive_project_file_links_project_idx on drive_project_file_links (project_id, object_key);`)
  await queryDb(`create index if not exists drive_project_file_links_active_idx on drive_project_file_links (mode, revoked_at, expires_at);`)
}

export async function listProjects(): Promise<Project[]> {
  await ensureProjectSchema()
  const { rows } = await queryDb<ProjectRow>(`
    select p.*,
      count(a.id)::int as key_count
    from drive_projects p
    left join drive_project_api_key_assignments a on a.project_id = p.id
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
  bucketName: string
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
      input.bucketName,
      input.createdAccountId ?? null,
      input.createdAccountLabel ?? null,
    ]
  )
  return mapProject(rows[0])
}

export async function updateProjectRecord(
  identifier: string,
  updates: { name?: string; status?: ProjectStatus }
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
        updated_at = now()
      where id = $1
      returning *;
    `,
    [current.id, nextName || null, updates.status ?? null]
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
  objectKey: string
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
        (project_id, object_key, token_hash, mode, expires_at)
      values ($1, $2, $3, $4, $5)
      returning *;
    `,
    [
      project.id,
      input.objectKey,
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
        p.bucket_name,
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
