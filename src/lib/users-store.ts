import crypto from "crypto"
import { getSupabaseServerClient } from "./supabase"

export type UserRole = "superadmin" | "admin" | "user"
export type UserStatus = "active" | "disabled"

export interface User {
  id: string
  name: string
  firstName: string
  lastName?: string
  username?: string
  email: string
  role: UserRole
  status: UserStatus
  quotaLimitMb: number
  quotaUsedMb: number
  profileImageUrl?: string
  googleLinked?: boolean
  googleSub?: string
  passwordSource?: "local" | "google-generated"
  passwordHash: string
}

export type PublicUser = Omit<User, "passwordHash">

type DriveUserRow = {
  id: string
  name: string
  first_name: string
  last_name: string | null
  username: string | null
  email: string
  role: UserRole
  status: UserStatus
  quota_limit_mb: number
  quota_used_mb: number
  profile_image_url: string
  google_linked: boolean
  google_sub: string | null
  password_source: "local" | "google-generated"
  password_hash: string
  created_at?: string
  updated_at?: string
}

const USERS_TABLE = "drive_users"

function normalizeSupabaseError(error: { message: string }): Error {
  const message = String(error?.message ?? "Supabase error")
  if (message.includes("Could not find the table") && message.includes(USERS_TABLE)) {
    return new Error(
      `Supabase table '${USERS_TABLE}' is missing. Create it by running 'supabase/drive_schema.sql' in the Supabase SQL editor for ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "your project"}.`
    )
  }
  return new Error(message)
}

export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex")
}

function normalizeNamePart(part?: string | null): string | undefined {
  if (!part) return undefined
  const trimmed = part.trim()
  if (!trimmed) return undefined
  const lower = trimmed.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function deriveNameParts(
  fullName: string | undefined,
  email: string | undefined
): { firstName: string; lastName?: string } {
  const baseName = (fullName ?? "").trim()
  const source =
    baseName.length > 0
      ? baseName
      : (email ?? "").split("@")[0]?.replace(/[._-]+/g, " ") ?? "User"

  const parts = source.trim().split(/\s+/)
  const rawFirst = parts[0] ?? "User"
  const rawLast = parts.length > 1 ? parts.slice(1).join(" ") : ""

  const firstName = normalizeNamePart(rawFirst) ?? "User"
  const lastName = normalizeNamePart(rawLast)

  return lastName ? { firstName, lastName } : { firstName }
}

function mapRow(row: DriveUserRow): User {
  return {
    id: row.id,
    name: row.name,
    firstName: row.first_name,
    lastName: row.last_name ?? undefined,
    username: row.username ?? undefined,
    email: row.email,
    role: row.role,
    status: row.status,
    quotaLimitMb: row.quota_limit_mb,
    quotaUsedMb: row.quota_used_mb,
    profileImageUrl: row.profile_image_url ?? "",
    googleLinked: row.google_linked ?? false,
    googleSub: row.google_sub ?? undefined,
    passwordSource: row.password_source ?? "local",
    passwordHash: row.password_hash,
  }
}

function mapUpdateToDb(
  updates: Partial<
    Pick<
      User,
      | "name"
      | "firstName"
      | "lastName"
      | "username"
      | "email"
      | "role"
      | "status"
      | "quotaLimitMb"
      | "quotaUsedMb"
      | "profileImageUrl"
      | "googleLinked"
      | "googleSub"
      | "passwordSource"
      | "passwordHash"
    >
  >
): Partial<DriveUserRow> {
  const next: Partial<DriveUserRow> = {}
  if (updates.name !== undefined) next.name = updates.name
  if (updates.firstName !== undefined) next.first_name = updates.firstName
  if (updates.lastName !== undefined) next.last_name = updates.lastName ?? null
  if (updates.username !== undefined)
    next.username = updates.username ? updates.username : null
  if (updates.email !== undefined) next.email = updates.email
  if (updates.role !== undefined) next.role = updates.role
  if (updates.status !== undefined) next.status = updates.status
  if (updates.quotaLimitMb !== undefined) next.quota_limit_mb = updates.quotaLimitMb
  if (updates.quotaUsedMb !== undefined) next.quota_used_mb = updates.quotaUsedMb
  if (updates.profileImageUrl !== undefined)
    next.profile_image_url = updates.profileImageUrl ?? ""
  if (updates.googleLinked !== undefined) next.google_linked = updates.googleLinked
  if (updates.googleSub !== undefined) next.google_sub = updates.googleSub ?? null
  if (updates.passwordSource !== undefined)
    next.password_source = updates.passwordSource
  if (updates.passwordHash !== undefined) next.password_hash = updates.passwordHash
  return next
}

export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user
  return rest
}

export async function getAllUsers(): Promise<User[]> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(USERS_TABLE)
    .select("*")
    .order("created_at", { ascending: true })

  if (error) throw normalizeSupabaseError(error)
  return (data as DriveUserRow[]).map(mapRow)
}

export async function hasAnyUsers(): Promise<boolean> {
  const supabase = getSupabaseServerClient()
  const { error, count } = await supabase
    .from(USERS_TABLE)
    .select("id", { count: "exact", head: true })

  if (error) throw normalizeSupabaseError(error)
  return (count ?? 0) > 0
}

export async function hasAdminUser(): Promise<boolean> {
  const supabase = getSupabaseServerClient()
  const { error, count } = await supabase
    .from(USERS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("role", "admin")

  if (error) throw normalizeSupabaseError(error)
  return (count ?? 0) > 0
}

export async function hasSuperAdminUser(): Promise<boolean> {
  const supabase = getSupabaseServerClient()
  const { error, count } = await supabase
    .from(USERS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("role", "superadmin")

  if (error) throw normalizeSupabaseError(error)
  return (count ?? 0) > 0
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const normalized = email.trim().toLowerCase()
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(USERS_TABLE)
    .select("*")
    .eq("email", normalized)
    .limit(1)

  if (error) throw normalizeSupabaseError(error)
  const row = (data as DriveUserRow[])[0]
  return row ? mapRow(row) : undefined
}

export async function findUserByUsername(
  username: string
): Promise<User | undefined> {
  const normalized = username.trim().toLowerCase()
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(USERS_TABLE)
    .select("*")
    .eq("username", normalized)
    .limit(1)

  if (error) throw normalizeSupabaseError(error)
  const row = (data as DriveUserRow[])[0]
  return row ? mapRow(row) : undefined
}

export async function findUserById(id: string): Promise<User | undefined> {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(USERS_TABLE)
    .select("*")
    .eq("id", id)
    .limit(1)

  if (error) throw normalizeSupabaseError(error)
  const row = (data as DriveUserRow[])[0]
  return row ? mapRow(row) : undefined
}

export async function createUser(input: {
  name: string
  username?: string
  email: string
  password: string
  role?: UserRole
  status?: UserStatus
  quotaLimitMb?: number
  profileImageUrl?: string
  googleLinked?: boolean
  googleSub?: string
  passwordSource?: "local" | "google-generated"
}): Promise<User> {
  const supabase = getSupabaseServerClient()

  const email = input.email.trim().toLowerCase()
  const existing = await findUserByEmail(email)
  if (existing) throw new Error("Email already in use")

  const username = input.username?.trim().toLowerCase()
  if (username) {
    if (username.includes("@")) throw new Error("Username cannot be an email address")
    const existingUsername = await findUserByUsername(username)
    if (existingUsername) throw new Error("Username already in use")
  }

  const { firstName, lastName } = deriveNameParts(input.name, email)
  const computedName =
    lastName && lastName.length > 0 ? `${firstName} ${lastName}` : firstName

  const superAdminCount = await supabase
    .from(USERS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("role", "superadmin")

  if (superAdminCount.error) throw normalizeSupabaseError(superAdminCount.error)
  const hasSuperAdmin = (superAdminCount.count ?? 0) > 0

  const role: UserRole = input.role ?? (hasSuperAdmin ? "user" : "superadmin")
  const quotaLimitMb =
    input.quotaLimitMb !== undefined
      ? input.quotaLimitMb
      : role === "superadmin"
        ? 0
        : 500

  const row: DriveUserRow = {
    id: crypto.randomUUID(),
    name: computedName,
    first_name: firstName,
    last_name: lastName ?? null,
    username: username ?? null,
    email,
    role,
    status: input.status ?? "active",
    quota_limit_mb: quotaLimitMb,
    quota_used_mb: 0,
    profile_image_url: input.profileImageUrl ?? "",
    google_linked: input.googleLinked ?? false,
    google_sub: input.googleSub ?? null,
    password_source: input.passwordSource ?? "local",
    password_hash: hashPassword(input.password),
  }

  const { data, error } = await supabase
    .from(USERS_TABLE)
    .insert(row)
    .select("*")
    .single()
  if (error) throw normalizeSupabaseError(error)
  return mapRow(data as DriveUserRow)
}

export async function updateUser(
  id: string,
  updates: Partial<
    Pick<
      User,
      | "name"
      | "firstName"
      | "lastName"
      | "username"
      | "email"
      | "role"
      | "status"
      | "quotaLimitMb"
      | "quotaUsedMb"
      | "profileImageUrl"
      | "googleLinked"
      | "googleSub"
      | "passwordSource"
      | "passwordHash"
    >
  >
): Promise<User> {
  const supabase = getSupabaseServerClient()

  const current = await findUserById(id)
  if (!current) throw new Error("User not found")

  const nextUpdates: typeof updates = { ...updates }

  if (nextUpdates.email) {
    const normalized = nextUpdates.email.trim().toLowerCase()
    const conflict = await findUserByEmail(normalized)
    if (conflict && conflict.id !== id) throw new Error("Email already in use")
    nextUpdates.email = normalized
  }

  if (nextUpdates.username) {
    const normalizedUsername = nextUpdates.username.trim().toLowerCase()
    if (normalizedUsername.includes("@")) throw new Error("Username cannot be an email address")
    const conflict = await findUserByUsername(normalizedUsername)
    if (conflict && conflict.id !== id) throw new Error("Username already in use")
    nextUpdates.username = normalizedUsername
  }

  let nextFirstName = current.firstName
  let nextLastName = current.lastName
  let nextName = current.name

  if (
    nextUpdates.firstName !== undefined ||
    nextUpdates.lastName !== undefined ||
    nextUpdates.name !== undefined
  ) {
    const fromName = nextUpdates.name !== undefined ? nextUpdates.name : current.name
    const fromFirst =
      nextUpdates.firstName !== undefined ? nextUpdates.firstName : current.firstName
    const fromLast =
      nextUpdates.lastName !== undefined ? nextUpdates.lastName : current.lastName

    if (nextUpdates.name && !nextUpdates.firstName && !nextUpdates.lastName) {
      const parts = deriveNameParts(
        nextUpdates.name,
        (nextUpdates.email as string | undefined) ?? current.email
      )
      nextFirstName = parts.firstName
      nextLastName = parts.lastName
    } else {
      nextFirstName = normalizeNamePart(fromFirst) ?? current.firstName
      nextLastName = normalizeNamePart(fromLast) ?? current.lastName
      if (!nextFirstName) {
        const parts = deriveNameParts(fromName, current.email)
        nextFirstName = parts.firstName
        nextLastName = parts.lastName
      }
    }

    nextName =
      nextLastName && nextLastName.length > 0
        ? `${nextFirstName} ${nextLastName}`
        : nextFirstName
  }

  const finalUpdates: Partial<User> = {
    ...nextUpdates,
    name: nextName,
    firstName: nextFirstName,
    lastName: nextLastName,
  }

  const dbUpdates = mapUpdateToDb(finalUpdates)
  const { data, error } = await supabase
    .from(USERS_TABLE)
    .update(dbUpdates)
    .eq("id", id)
    .select("*")
    .single()

  if (error) throw normalizeSupabaseError(error)
  return mapRow(data as DriveUserRow)
}

export async function deleteUser(id: string): Promise<void> {
  const supabase = getSupabaseServerClient()
  const { error } = await supabase.from(USERS_TABLE).delete().eq("id", id)
  if (error) throw normalizeSupabaseError(error)
}

export async function searchUsers(
  query?: string,
  role?: UserRole
): Promise<User[]> {
  const supabase = getSupabaseServerClient()
  let q = supabase.from(USERS_TABLE).select("*")

  if (role) q = q.eq("role", role)

  const term = query?.trim()
  if (term) {
    const escaped = term.replace(/,/g, "\\,")
    q = q.or(
      [
        `name.ilike.%${escaped}%`,
        `email.ilike.%${escaped}%`,
        `role.ilike.%${escaped}%`,
        `status.ilike.%${escaped}%`,
      ].join(",")
    )
  }

  const { data, error } = await q.order("created_at", { ascending: true })
  if (error) throw normalizeSupabaseError(error)
  return (data as DriveUserRow[]).map(mapRow)
}
