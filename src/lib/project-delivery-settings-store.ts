import { isPostgresConfigured, queryDb } from "./db"
import { normalizeMediaAllowedOrigins } from "./project-media-origins.cjs"

export type ProjectDeliverySettings = {
  projectId: string
  mediaAllowedOrigins: string[] | null
  updatedAt?: string
}

type Row = {
  project_id: string
  media_allowed_origins: string[] | null
  updated_at: string
}

let schemaReady: Promise<void> | undefined

function map(row: Row): ProjectDeliverySettings {
  return {
    projectId: row.project_id,
    mediaAllowedOrigins: row.media_allowed_origins,
    updatedAt: row.updated_at,
  }
}

function defaults(projectId: string): ProjectDeliverySettings {
  return { projectId, mediaAllowedOrigins: null }
}

export async function ensureProjectDeliverySettingsSchema() {
  if (!isPostgresConfigured()) return
  schemaReady ??= queryDb(`
    create table if not exists drive_project_delivery_settings (
      project_id uuid primary key references drive_projects(id) on delete cascade,
      media_allowed_origins text[],
      updated_at timestamptz not null default now()
    );
  `).then(() => undefined).catch((error) => { schemaReady = undefined; throw error })
  return schemaReady
}

export async function getProjectDeliverySettings(projectId: string): Promise<ProjectDeliverySettings> {
  await ensureProjectDeliverySettingsSchema()
  if (!isPostgresConfigured()) return defaults(projectId)
  const { rows } = await queryDb<Row>(
    `select project_id, media_allowed_origins, updated_at from drive_project_delivery_settings where project_id = $1 limit 1`,
    [projectId]
  )
  return rows[0] ? map(rows[0]) : defaults(projectId)
}

export async function listProjectDeliverySettings(projectIds: string[]) {
  await ensureProjectDeliverySettingsSchema()
  const ids = Array.from(new Set(projectIds.filter(Boolean)))
  const settings = new Map<string, ProjectDeliverySettings>(
    ids.map((projectId) => [projectId, defaults(projectId)])
  )
  if (!isPostgresConfigured() || ids.length === 0) return settings
  const { rows } = await queryDb<Row>(
    `
      select project_id, media_allowed_origins, updated_at
      from drive_project_delivery_settings
      where project_id = any($1::uuid[]);
    `,
    [ids]
  )
  for (const row of rows) settings.set(row.project_id, map(row))
  return settings
}

export async function updateProjectDeliverySettings(input: {
  projectId: string
  mediaAllowedOrigins?: unknown | null
}) {
  const hasOrigins = input.mediaAllowedOrigins !== undefined
  if (!hasOrigins) throw new Error("No project delivery policy change was provided")
  const origins = input.mediaAllowedOrigins === null ? null : hasOrigins ? normalizeMediaAllowedOrigins(input.mediaAllowedOrigins) : null
  await ensureProjectDeliverySettingsSchema()
  if (!isPostgresConfigured()) return { ...defaults(input.projectId), mediaAllowedOrigins: origins }
  const { rows } = await queryDb<Row>(
    `
      insert into drive_project_delivery_settings (project_id, media_allowed_origins)
      values ($1, $2::text[])
      on conflict (project_id) do update set
        media_allowed_origins = excluded.media_allowed_origins,
        updated_at = now()
      returning project_id, media_allowed_origins, updated_at;
    `,
    [input.projectId, origins]
  )
  return map(rows[0])
}
