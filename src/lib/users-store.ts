import crypto from "crypto"
import { queryDb, withDbTransaction } from "./db"

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
  emailVerified?: boolean
  emailVerifiedAt?: string
  mobileNumber?: string
  mobileVerified?: boolean
  mobileVerifiedAt?: string
  passwordSource?: "local" | "google-generated"
  twoFactorEnabled?: boolean
  totpEnabled?: boolean
  totpSecret?: string
  totpLastUsedCounter?: number | null
  passwordHash: string
}

export type PublicUser = Omit<User, "passwordHash" | "totpSecret" | "totpLastUsedCounter">

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
  email_verified: boolean
  email_verified_at: string | null
  mobile_number: string | null
  mobile_verified: boolean
  mobile_verified_at: string | null
  password_source: "local" | "google-generated"
  two_factor_enabled: boolean
  totp_enabled: boolean
  totp_secret: string | null
  totp_last_used_counter: number | null
  password_hash: string
  created_at?: string
  updated_at?: string
}

function normalizeDatabaseError(error: unknown): Error {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "")
    const constraint = String((error as { constraint?: unknown }).constraint ?? "")
    if (code === "23505" && constraint.includes("email")) return new Error("Email already in use")
    if (code === "23505" && constraint.includes("username")) return new Error("Username already in use")
  }
  return error instanceof Error ? error : new Error("Database request failed")
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

function usernameIsValid(value: string) {
  return /^[a-z0-9_][a-z0-9_.-]{2,29}$/.test(value)
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
    emailVerified: row.email_verified ?? true,
    emailVerifiedAt: row.email_verified_at ?? undefined,
    mobileNumber: row.mobile_number ?? undefined,
    mobileVerified: row.mobile_verified ?? false,
    mobileVerifiedAt: row.mobile_verified_at ?? undefined,
    passwordSource: row.password_source ?? "local",
    twoFactorEnabled: row.two_factor_enabled ?? row.totp_enabled ?? false,
    totpEnabled: row.totp_enabled ?? false,
    totpSecret: row.totp_secret ?? undefined,
    totpLastUsedCounter: row.totp_last_used_counter ?? undefined,
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
      | "emailVerified"
      | "emailVerifiedAt"
      | "mobileNumber"
      | "mobileVerified"
      | "mobileVerifiedAt"
      | "passwordSource"
      | "twoFactorEnabled"
      | "totpEnabled"
      | "totpSecret"
      | "totpLastUsedCounter"
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
  if (updates.emailVerified !== undefined) next.email_verified = updates.emailVerified
  if (updates.emailVerifiedAt !== undefined)
    next.email_verified_at = updates.emailVerifiedAt ?? null
  if (updates.mobileNumber !== undefined)
    next.mobile_number = updates.mobileNumber ?? null
  if (updates.mobileVerified !== undefined) next.mobile_verified = updates.mobileVerified
  if (updates.mobileVerifiedAt !== undefined)
    next.mobile_verified_at = updates.mobileVerifiedAt ?? null
  if (updates.passwordSource !== undefined)
    next.password_source = updates.passwordSource
  if (updates.twoFactorEnabled !== undefined)
    next.two_factor_enabled = updates.twoFactorEnabled
  if (updates.totpEnabled !== undefined) next.totp_enabled = updates.totpEnabled
  if (updates.totpSecret !== undefined) next.totp_secret = updates.totpSecret ?? null
  if (updates.totpLastUsedCounter !== undefined)
    next.totp_last_used_counter = updates.totpLastUsedCounter ?? null
  if (updates.passwordHash !== undefined) next.password_hash = updates.passwordHash
  return next
}

export function toPublicUser(user: User): PublicUser {
  const rest = { ...user }
  delete (rest as Partial<User>).passwordHash
  delete (rest as Partial<User>).totpSecret
  delete (rest as Partial<User>).totpLastUsedCounter
  return rest
}

export async function getAllUsers(): Promise<User[]> {
  const { rows } = await queryDb<DriveUserRow>(`select * from public.drive_users order by created_at asc, id asc`)
  return rows.map(mapRow)
}

export async function hasAnyUsers(): Promise<boolean> {
  const { rows } = await queryDb<{ exists: boolean }>(`select exists(select 1 from public.drive_users) as exists`)
  return rows[0]?.exists === true
}

export async function hasAdminUser(): Promise<boolean> {
  const { rows } = await queryDb<{ exists: boolean }>(`select exists(select 1 from public.drive_users where role = 'admin') as exists`)
  return rows[0]?.exists === true
}

export async function hasSuperAdminUser(): Promise<boolean> {
  const { rows } = await queryDb<{ exists: boolean }>(`select exists(select 1 from public.drive_users where role = 'superadmin') as exists`)
  return rows[0]?.exists === true
}

export async function hasActiveSuperAdmin(excludingUserId?: string): Promise<boolean> {
  const { rows } = await queryDb<{ exists: boolean }>(
    `select exists(
       select 1 from public.drive_users
       where role = 'superadmin' and status = 'active'
         and ($1::text is null or id <> $1)
     ) as exists`,
    [excludingUserId ?? null]
  )
  return rows[0]?.exists === true
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const normalized = email.trim().toLowerCase()
  const { rows } = await queryDb<DriveUserRow>(`select * from public.drive_users where email = $1 limit 1`, [normalized])
  const row = rows[0]
  return row ? mapRow(row) : undefined
}

export async function findUserByUsername(
  username: string
): Promise<User | undefined> {
  const normalized = username.trim().toLowerCase()
  const { rows } = await queryDb<DriveUserRow>(`select * from public.drive_users where username = $1 limit 1`, [normalized])
  const row = rows[0]
  return row ? mapRow(row) : undefined
}

export async function findUserById(id: string): Promise<User | undefined> {
  const { rows } = await queryDb<DriveUserRow>(`select * from public.drive_users where id = $1 limit 1`, [id])
  const row = rows[0]
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
  emailVerified?: boolean
  emailVerifiedAt?: string
  mobileNumber?: string
  mobileVerified?: boolean
  mobileVerifiedAt?: string
  passwordSource?: "local" | "google-generated"
  twoFactorEnabled?: boolean
  totpEnabled?: boolean
  totpSecret?: string
}): Promise<User> {
  const email = input.email.trim().toLowerCase()
  const username = input.username?.trim().toLowerCase()
  if (username) {
    if (username.includes("@")) throw new Error("Username cannot be an email address")
    if (!usernameIsValid(username)) {
      throw new Error("Username must be 3-30 characters and use letters, numbers, dots, dashes, or underscores")
    }
  }

  const { firstName, lastName } = deriveNameParts(input.name, email)
  const computedName =
    lastName && lastName.length > 0 ? `${firstName} ${lastName}` : firstName

  const row = {
    id: crypto.randomUUID(),
    name: computedName,
    first_name: firstName,
    last_name: lastName ?? null,
    username: username ?? null,
    email,
    status: input.status ?? "active",
    quota_used_mb: 0,
    profile_image_url: input.profileImageUrl ?? "",
    google_linked: input.googleLinked ?? false,
    google_sub: input.googleSub ?? null,
    email_verified: input.emailVerified ?? false,
    email_verified_at: input.emailVerifiedAt ?? null,
    mobile_number: input.mobileNumber ?? null,
    mobile_verified: input.mobileVerified ?? false,
    mobile_verified_at: input.mobileVerifiedAt ?? null,
    password_source: input.passwordSource ?? "local",
    two_factor_enabled: input.twoFactorEnabled ?? input.totpEnabled ?? false,
    totp_enabled: input.totpEnabled ?? false,
    totp_secret: input.totpSecret ?? null,
    totp_last_used_counter: null,
    password_hash: hashPassword(input.password),
  }

  try {
    return await withDbTransaction(async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtext('drive.users.create'))`)
      const existing = await client.query(`select 1 from public.drive_users where email = $1 limit 1`, [email])
      if (existing.rowCount) throw new Error("Email already in use")
      if (username) {
        const existingUsername = await client.query(`select 1 from public.drive_users where username = $1 limit 1`, [username])
        if (existingUsername.rowCount) throw new Error("Username already in use")
      }
      const superAdmins = await client.query<{ exists: boolean }>(`select exists(select 1 from public.drive_users where role = 'superadmin') as exists`)
      const resolvedRole: UserRole = input.role ?? (superAdmins.rows[0]?.exists ? "user" : "superadmin")
      const resolvedQuota = input.quotaLimitMb !== undefined ? input.quotaLimitMb : resolvedRole === "superadmin" ? 0 : 500
      const created = await client.query<DriveUserRow>(
        `insert into public.drive_users (
          id, name, first_name, last_name, username, email, role, status,
          quota_limit_mb, quota_used_mb, profile_image_url, google_linked, google_sub,
          email_verified, email_verified_at, mobile_number, mobile_verified, mobile_verified_at,
          password_source, two_factor_enabled, totp_enabled, totp_secret,
          totp_last_used_counter, password_hash
        ) values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
        ) returning *`,
        [row.id, row.name, row.first_name, row.last_name, row.username, row.email, resolvedRole, row.status,
          resolvedQuota, row.quota_used_mb, row.profile_image_url, row.google_linked, row.google_sub,
          row.email_verified, row.email_verified_at, row.mobile_number, row.mobile_verified, row.mobile_verified_at,
          row.password_source, row.two_factor_enabled, row.totp_enabled, row.totp_secret,
          row.totp_last_used_counter, row.password_hash]
      )
      return mapRow(created.rows[0])
    })
  } catch (error) {
    throw normalizeDatabaseError(error)
  }
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
      | "emailVerified"
      | "emailVerifiedAt"
      | "mobileNumber"
      | "mobileVerified"
      | "mobileVerifiedAt"
      | "passwordSource"
      | "twoFactorEnabled"
      | "totpEnabled"
      | "totpSecret"
      | "totpLastUsedCounter"
      | "passwordHash"
    >
  >
): Promise<User> {
  const nextUpdates: typeof updates = { ...updates }

  if (nextUpdates.email) {
    const normalized = nextUpdates.email.trim().toLowerCase()
    nextUpdates.email = normalized
  }

  if (nextUpdates.username) {
    const normalizedUsername = nextUpdates.username.trim().toLowerCase()
    if (normalizedUsername.includes("@")) throw new Error("Username cannot be an email address")
    if (!usernameIsValid(normalizedUsername)) {
      throw new Error("Username must be 3-30 characters and use letters, numbers, dots, dashes, or underscores")
    }
    nextUpdates.username = normalizedUsername
  }

  try {
    return await withDbTransaction(async (client) => {
      const currentResult = await client.query<DriveUserRow>(`select * from public.drive_users where id = $1 for update`, [id])
      const currentRow = currentResult.rows[0]
      if (!currentRow) throw new Error("User not found")
      const current = mapRow(currentRow)

      if (nextUpdates.email) {
        const conflict = await client.query(`select 1 from public.drive_users where email = $1 and id <> $2 limit 1`, [nextUpdates.email, id])
        if (conflict.rowCount) throw new Error("Email already in use")
      }
      if (nextUpdates.username) {
        const conflict = await client.query(`select 1 from public.drive_users where username = $1 and id <> $2 limit 1`, [nextUpdates.username, id])
        if (conflict.rowCount) throw new Error("Username already in use")
      }

      let nextFirstName = current.firstName
      let nextLastName = current.lastName
      let nextName = current.name
      if (nextUpdates.firstName !== undefined || nextUpdates.lastName !== undefined || nextUpdates.name !== undefined) {
        const fromName = nextUpdates.name !== undefined ? nextUpdates.name : current.name
        const fromFirst = nextUpdates.firstName !== undefined ? nextUpdates.firstName : current.firstName
        const fromLast = nextUpdates.lastName !== undefined ? nextUpdates.lastName : current.lastName
        if (nextUpdates.name && !nextUpdates.firstName && !nextUpdates.lastName) {
          const parts = deriveNameParts(nextUpdates.name, nextUpdates.email ?? current.email)
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
        nextName = nextLastName ? `${nextFirstName} ${nextLastName}` : nextFirstName
      }

      const dbUpdates = mapUpdateToDb({ ...nextUpdates, name: nextName, firstName: nextFirstName, lastName: nextLastName })
      const entries = Object.entries(dbUpdates)
      const values: unknown[] = [id]
      const assignments = entries.map(([column, value], index) => {
        values.push(value)
        return `"${column}" = $${index + 2}`
      })
      const updated = await client.query<DriveUserRow>(
        `update public.drive_users set ${assignments.join(", ")}, updated_at = now() where id = $1 returning *`,
        values
      )
      return mapRow(updated.rows[0])
    })
  } catch (error) {
    throw normalizeDatabaseError(error)
  }
}

export async function markTotpCounterUsed(userId: string, counter: number): Promise<boolean> {
  const result = await queryDb<{ id: string }>(
    `update public.drive_users set totp_last_used_counter = $2 where id = $1 and (totp_last_used_counter is null or totp_last_used_counter < $2) returning id`,
    [userId, counter]
  )
  return (result.rowCount ?? 0) > 0
}

export async function deleteUser(id: string): Promise<void> {
  await queryDb(`delete from public.drive_users where id = $1`, [id])
}

export async function searchUsers(
  query?: string,
  role?: UserRole
): Promise<User[]> {
  const values: unknown[] = []
  const conditions: string[] = []
  if (role) {
    values.push(role)
    conditions.push(`role = $${values.length}`)
  }
  const term = query?.trim()
  if (term) {
    values.push(`%${term}%`)
    const parameter = `$${values.length}`
    conditions.push(`(name ilike ${parameter} or email ilike ${parameter} or coalesce(username, '') ilike ${parameter} or role ilike ${parameter} or status ilike ${parameter})`)
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : ""
  const { rows } = await queryDb<DriveUserRow>(
    `select * from public.drive_users ${where} order by created_at asc, id asc`,
    values
  )
  return rows.map(mapRow)
}
