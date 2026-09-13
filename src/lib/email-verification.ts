import crypto from "crypto"
import { withDbTransaction } from "./db"
import { findUserById, toPublicUser, type PublicUser } from "./users-store"

export type VerificationPurpose = "signup" | "login" | "password-reset"

type VerificationRow = {
  id: string
  user_id: string
  token_hash: string
  email: string
  purpose: VerificationPurpose
  attempts: number
  expires_at: string
  consumed_at: string | null
  created_at: string
}

const TABLE = "drive_email_verification_tokens"
const CODE_TTL_MINUTES = 5

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function hashCode(userId: string, email: string, purpose: VerificationPurpose, code: string): string {
  return crypto
    .createHash("sha256")
    .update(`${userId}:${normalizeEmail(email)}:${purpose}:${code}`)
    .digest("hex")
}

function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0")
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export async function createEmailVerificationCode(
  userId: string,
  email: string,
  purpose: VerificationPurpose
) {
  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString()
  const normalizedEmail = normalizeEmail(email)

  await withDbTransaction(async (client) => {
    await client.query(`delete from public.${TABLE} where user_id=$1 and purpose=$2 and consumed_at is null`, [userId, purpose])
    await client.query(`
      insert into public.${TABLE}(id,user_id,token_hash,email,purpose,attempts,expires_at)
      values($1,$2,$3,$4,$5,0,$6)
    `, [crypto.randomUUID(), userId, hashCode(userId, normalizedEmail, purpose, code), normalizedEmail, purpose, expiresAt])
  })

  return { code, expiresAt }
}

export async function sendVerificationEmail(input: {
  userId: string
  email: string
  name: string
  request: Request
  purpose?: VerificationPurpose
}) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL || process.env.RESEND_FROM || "Drive <onboarding@resend.dev>"
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured")
  }

  const purpose = input.purpose ?? "signup"
  const { code } = await createEmailVerificationCode(input.userId, input.email, purpose)
  const safeName = escapeHtml(input.name || "there")
  const title =
    purpose === "login"
      ? "Your Drive sign-in code"
      : purpose === "password-reset"
        ? "Your Drive password reset code"
        : "Verify your Drive account"
  const intro =
    purpose === "login"
      ? "Enter this code to finish signing in to your account."
      : purpose === "password-reset"
        ? "Enter this code to reset your password."
      : "Enter this code to verify your email address and finish setting up your account."
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
      <h1 style="font-size:20px;margin:0 0 12px">${title}</h1>
      <p>Hello ${safeName},</p>
      <p>${intro}</p>
      <div style="font-size:28px;letter-spacing:8px;font-weight:700;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;padding:14px 18px;display:inline-block">${code}</div>
      <p style="font-size:13px;color:#6b7280">This code expires in ${CODE_TTL_MINUTES} minutes. If you did not request it, you can ignore this email.</p>
    </div>
  `

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.email],
      subject: title,
      html,
    }),
  })

  const data: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message?: unknown }).message)
        : "Unable to send verification email"
    throw new Error(message)
  }
}

export async function verifyEmailCode(input: {
  email: string
  code: string
  purpose: VerificationPurpose
  consume?: boolean
}): Promise<PublicUser> {
  const code = input.code.replace(/\D/g, "")
  if (code.length !== 6) throw new Error("Enter the 6-digit verification code")

  const email = normalizeEmail(input.email)
  const outcome = await withDbTransaction(async (client) => {
    const result = await client.query<VerificationRow>(`
      select * from public.${TABLE}
      where email=$1 and purpose=$2 and consumed_at is null
      order by created_at desc limit 1 for update
    `, [email, input.purpose])
    const row = result.rows[0]
    if (!row) return { error: "Verification code is invalid" }
    if (new Date(row.expires_at).getTime() < Date.now()) return { error: "Verification code has expired" }
    if (row.attempts >= 5) return { error: "Verification code has too many failed attempts. Request a new code." }
    const expected = Buffer.from(hashCode(row.user_id, email, input.purpose, code), "hex")
    const actual = Buffer.from(row.token_hash, "hex")
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      await client.query(`update public.${TABLE} set attempts=attempts+1 where id=$1`, [row.id])
      return { error: "Verification code is invalid" }
    }
    const userResult = await client.query<{ id: string; email: string; email_verified: boolean }>(
      `select id,email,email_verified from public.drive_users where id=$1 for update`, [row.user_id]
    )
    const user = userResult.rows[0]
    if (!user) return { error: "User not found" }
    if (user.email.toLowerCase() !== email) return { error: "Verification email no longer matches this account" }
    const consumedAt = new Date().toISOString()
    if (input.consume !== false) {
      const consumed = await client.query(`update public.${TABLE} set consumed_at=$2 where id=$1 and consumed_at is null`, [row.id, consumedAt])
      if (consumed.rowCount !== 1) return { error: "Verification code has already been used" }
      if (input.purpose === "signup" && !user.email_verified) {
        await client.query(`update public.drive_users set email_verified=true,email_verified_at=$2,updated_at=now() where id=$1`, [user.id, consumedAt])
      }
    }
    return { userId: user.id }
  })
  if ("error" in outcome) throw new Error(outcome.error)
  const user = await findUserById(outcome.userId)
  if (!user) throw new Error("User not found")
  return toPublicUser(user)
}
