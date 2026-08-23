import crypto from "crypto"
import { queryDb } from "./db"
import { getAllAccounts, updateAccount, type CloudflareAccountStatus } from "./accounts-store"
import { findUserById } from "./users-store"

export type ActivityOutcome = "success" | "failed" | "warning" | "info"
export type ActivityUndoStatus = "not_undoable" | "available" | "undone" | "expired" | "failed"

export type ActivityRecord = {
  id: string
  occurredAt: string
  actorUserId?: string
  actorName?: string
  actorEmail?: string
  actorRole?: string
  action: string
  entityType: string
  entityId?: string
  entityLabel?: string
  summary: string
  detail?: string
  outcome: ActivityOutcome
  ipAddress?: string
  userAgent?: string
  requestId?: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  metadata?: Record<string, unknown>
  undoable: boolean
  undoStatus: ActivityUndoStatus
  undoReason?: string
  undoneAt?: string
  undoneByUserId?: string
}

type ActivityRow = {
  id: string
  occurred_at: string
  actor_user_id: string | null
  actor_name: string | null
  actor_email: string | null
  actor_role: string | null
  action: string
  entity_type: string
  entity_id: string | null
  entity_label: string | null
  summary: string
  detail: string | null
  outcome: ActivityOutcome
  ip_address: string | null
  user_agent: string | null
  request_id: string | null
  before_state: Record<string, unknown> | null
  after_state: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  undoable: boolean
  undo_status: ActivityUndoStatus
  undo_reason: string | null
  undone_at: string | null
  undone_by_user_id: string | null
}

export type ListActivityInput = {
  q?: string
  actorUserId?: string
  action?: string
  entityType?: string
  outcome?: string
  undoable?: boolean
  from?: string
  to?: string
  cursor?: string
  limit?: number
}

type CountRow = {
  total: string | number
}

export type RecordActivityInput = {
  actorUserId?: string | null
  action: string
  entityType: string
  entityId?: string | null
  entityLabel?: string | null
  summary: string
  detail?: string | null
  outcome?: ActivityOutcome
  ipAddress?: string | null
  userAgent?: string | null
  requestId?: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
  undoable?: boolean
  undoStatus?: ActivityUndoStatus
  undoReason?: string | null
  undoPayload?: Record<string, unknown> | null
}

const TABLE = "drive_activity_events"

function mapRow(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorUserId: row.actor_user_id ?? undefined,
    actorName: row.actor_name ?? undefined,
    actorEmail: row.actor_email ?? undefined,
    actorRole: row.actor_role ?? undefined,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id ?? undefined,
    entityLabel: row.entity_label ?? undefined,
    summary: row.summary,
    detail: row.detail ?? undefined,
    outcome: row.outcome,
    ipAddress: row.ip_address ?? undefined,
    userAgent: row.user_agent ?? undefined,
    requestId: row.request_id ?? undefined,
    before: row.before_state ?? undefined,
    after: row.after_state ?? undefined,
    metadata: row.metadata ?? undefined,
    undoable: row.undoable,
    undoStatus: row.undo_status,
    undoReason: row.undo_reason ?? undefined,
    undoneAt: row.undone_at ?? undefined,
    undoneByUserId: row.undone_by_user_id ?? undefined,
  }
}

function encodeCursor(row: Pick<ActivityRow, "occurred_at" | "id">): string {
  return Buffer.from(JSON.stringify({ at: row.occurred_at, id: row.id }), "utf8").toString("base64url")
}

function decodeCursor(cursor?: string): { at: string; id: string } | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { at?: unknown; id?: unknown }
    if (typeof parsed.at === "string" && typeof parsed.id === "string") return { at: parsed.at, id: parsed.id }
  } catch {
    return null
  }
  return null
}

function toJson(value: Record<string, unknown> | null | undefined) {
  return value ? JSON.stringify(value) : null
}

function searchText(input: RecordActivityInput & { actorName?: string; actorEmail?: string; actorRole?: string }) {
  return [
    input.actorName,
    input.actorEmail,
    input.actorRole,
    input.action,
    input.entityType,
    input.entityId,
    input.entityLabel,
    input.summary,
    input.detail,
    input.outcome ?? "success",
  ]
    .filter(Boolean)
    .join(" ")
}

let activitySchemaReady: Promise<void> | undefined

export function ensureActivitySchema(): Promise<void> {
  if (!activitySchemaReady) {
    activitySchemaReady = (async () => {
      await queryDb(`create extension if not exists pgcrypto;`)
  await queryDb(`
    create table if not exists ${TABLE} (
      id uuid primary key default gen_random_uuid(),
      occurred_at timestamptz not null default now(),
      actor_user_id uuid references drive_users(id) on delete set null,
      actor_name text,
      actor_email text,
      actor_role text,
      action text not null,
      entity_type text not null,
      entity_id text,
      entity_label text,
      summary text not null,
      detail text,
      outcome text not null default 'success',
      ip_address text,
      user_agent text,
      request_id text,
      before_state jsonb,
      after_state jsonb,
      metadata jsonb not null default '{}'::jsonb,
      search_text text not null default '',
      undoable boolean not null default false,
      undo_status text not null default 'not_undoable',
      undo_reason text,
      undo_payload jsonb,
      undone_at timestamptz,
      undone_by_user_id uuid references drive_users(id) on delete set null
    );
  `)
  await queryDb(`create index if not exists drive_activity_events_time_idx on ${TABLE} (occurred_at desc, id desc);`)
  await queryDb(`create index if not exists drive_activity_events_actor_time_idx on ${TABLE} (actor_user_id, occurred_at desc, id desc);`)
  await queryDb(`create index if not exists drive_activity_events_action_time_idx on ${TABLE} (action, occurred_at desc, id desc);`)
  await queryDb(`create index if not exists drive_activity_events_entity_time_idx on ${TABLE} (entity_type, entity_id, occurred_at desc, id desc);`)
  await queryDb(`create index if not exists drive_activity_events_outcome_time_idx on ${TABLE} (outcome, occurred_at desc, id desc);`)
  await queryDb(`create index if not exists drive_activity_events_undo_time_idx on ${TABLE} (undoable, undo_status, occurred_at desc, id desc);`)
      await queryDb(`create index if not exists drive_activity_events_search_trgm_idx on ${TABLE} using gin (search_text gin_trgm_ops);`).catch(async () => {
        await queryDb(`create extension if not exists pg_trgm;`)
        await queryDb(`create index if not exists drive_activity_events_search_trgm_idx on ${TABLE} using gin (search_text gin_trgm_ops);`)
      })
    })().catch((error) => {
      activitySchemaReady = undefined
      throw error
    })
  }
  return activitySchemaReady
}

export function getRequestActivityContext(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return {
    ipAddress: forwardedFor || request.headers.get("x-real-ip") || null,
    userAgent: request.headers.get("user-agent") || null,
    requestId: request.headers.get("x-request-id") || crypto.randomUUID(),
  }
}

export async function recordActivity(input: RecordActivityInput): Promise<ActivityRecord | null> {
  try {
    await ensureActivitySchema()
    const actor = input.actorUserId ? await findUserById(input.actorUserId).catch(() => undefined) : undefined
    const enriched = {
      ...input,
      actorName: actor?.name,
      actorEmail: actor?.email,
      actorRole: actor?.role,
      outcome: input.outcome ?? "success",
    }
    const undoable = Boolean(input.undoable)
    const undoStatus = input.undoStatus ?? (undoable ? "available" : "not_undoable")
    const { rows } = await queryDb<ActivityRow>(
      `
        insert into ${TABLE}
          (actor_user_id, actor_name, actor_email, actor_role, action, entity_type, entity_id, entity_label,
           summary, detail, outcome, ip_address, user_agent, request_id, before_state, after_state, metadata,
           search_text, undoable, undo_status, undo_reason, undo_payload)
        values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb,
           coalesce($17::jsonb, '{}'::jsonb), $18, $19, $20, $21, $22::jsonb)
        returning *
      `,
      [
        input.actorUserId ?? null,
        enriched.actorName ?? null,
        enriched.actorEmail ?? null,
        enriched.actorRole ?? null,
        input.action,
        input.entityType,
        input.entityId ?? null,
        input.entityLabel ?? null,
        input.summary,
        input.detail ?? null,
        enriched.outcome,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        input.requestId ?? null,
        toJson(input.before),
        toJson(input.after),
        toJson(input.metadata),
        searchText(enriched),
        undoable,
        undoStatus,
        input.undoReason ?? null,
        toJson(input.undoPayload),
      ]
    )
    return rows[0] ? mapRow(rows[0]) : null
  } catch (error) {
    console.error("Unable to record activity:", error)
    return null
  }
}

export async function listActivity(input: ListActivityInput) {
  await ensureActivitySchema()
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 25)))
  const cursor = decodeCursor(input.cursor)
  const baseClauses: string[] = []
  const params: unknown[] = []
  const add = (value: unknown) => {
    params.push(value)
    return `$${params.length}`
  }

  if (input.q?.trim()) baseClauses.push(`search_text ilike ${add(`%${input.q.trim()}%`)}`)
  if (input.actorUserId) baseClauses.push(`actor_user_id = ${add(input.actorUserId)}`)
  if (input.action) baseClauses.push(`action = ${add(input.action)}`)
  if (input.entityType) baseClauses.push(`entity_type = ${add(input.entityType)}`)
  if (input.outcome) baseClauses.push(`outcome = ${add(input.outcome)}`)
  if (input.undoable !== undefined) baseClauses.push(`undoable = ${add(input.undoable)}`)
  if (input.from) baseClauses.push(`occurred_at >= ${add(input.from)}`)
  if (input.to) baseClauses.push(`occurred_at <= ${add(input.to)}`)

  const countParams = [...params]
  const pageClauses = [...baseClauses]
  if (cursor) pageClauses.push(`(occurred_at, id) < (${add(cursor.at)}::timestamptz, ${add(cursor.id)}::uuid)`)

  const baseWhere = baseClauses.length ? `where ${baseClauses.join(" and ")}` : ""
  const where = pageClauses.length ? `where ${pageClauses.join(" and ")}` : ""
  const [{ rows: countRows }, { rows }] = await Promise.all([
    queryDb<CountRow>(`select count(*)::bigint as total from ${TABLE} ${baseWhere}`, countParams),
    queryDb<ActivityRow>(
      `select * from ${TABLE} ${where} order by occurred_at desc, id desc limit ${add(limit + 1)}`,
      params
    ),
  ])
  const pageRows = rows.slice(0, limit)
  const totalCount = Number(countRows[0]?.total ?? 0)
  return {
    events: pageRows.map(mapRow),
    nextCursor: rows.length > limit && pageRows.length > 0 ? encodeCursor(pageRows[pageRows.length - 1]) : null,
    hasMore: rows.length > limit,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / limit)),
    generatedAt: new Date().toISOString(),
  }
}

export async function undoActivity(id: string, actorUserId?: string | null, request?: Request) {
  await ensureActivitySchema()
  const { rows } = await queryDb<ActivityRow & { undo_payload: Record<string, unknown> | null }>(
    `select * from ${TABLE} where id = $1 limit 1`,
    [id]
  )
  const event = rows[0]
  if (!event) throw new Error("Activity event not found")
  if (!event.undoable || event.undo_status !== "available") {
    throw new Error(event.undo_reason || "This activity cannot be undone")
  }

  const payload = event.undo_payload
  if (!payload || payload.type !== "restore_account_statuses" || !Array.isArray(payload.accounts)) {
    throw new Error("Undo payload is not supported")
  }

  const accounts = await getAllAccounts()
  const existingIds = new Set(accounts.map((account) => account.id))
  const restoreAccounts = payload.accounts as Array<{ id?: unknown; status?: unknown; lastMigrated?: unknown }>
  for (const account of restoreAccounts) {
    if (typeof account.id !== "string" || !existingIds.has(account.id)) {
      throw new Error("Cannot undo because one of the affected accounts no longer exists")
    }
    if (account.status !== "active" && account.status !== "disabled" && account.status !== "available") {
      throw new Error("Undo payload contains an invalid account status")
    }
  }

  const orderedRestoreAccounts = [...restoreAccounts].sort((a, b) => {
    if (a.status === "active") return -1
    if (b.status === "active") return 1
    return 0
  })

  for (const account of orderedRestoreAccounts) {
    await updateAccount(account.id as string, {
      status: account.status as CloudflareAccountStatus,
      lastMigrated: typeof account.lastMigrated === "string" ? account.lastMigrated : undefined,
    })
  }

  await queryDb(
    `update ${TABLE} set undo_status = 'undone', undone_at = now(), undone_by_user_id = $2 where id = $1`,
    [id, actorUserId ?? null]
  )

  await recordActivity({
    actorUserId,
    action: "activity.undo",
    entityType: event.entity_type,
    entityId: event.entity_id,
    entityLabel: event.entity_label,
    summary: `Undid: ${event.summary}`,
    detail: "Restored the captured account statuses from before the original action.",
    before: event.after_state,
    after: event.before_state,
    metadata: { undoneActivityId: id },
    ...getRequestActivityContext(request ?? new Request("http://local")),
  })
}
