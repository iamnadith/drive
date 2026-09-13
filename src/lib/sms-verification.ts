import crypto from "crypto"
import { withDbTransaction } from "./db"
import { findUserById, toPublicUser, type PublicUser } from "./users-store"
import type { VerificationPurpose } from "./email-verification"

type SmsVerificationPurpose = VerificationPurpose | "mobile-setup"

type SmsVerificationRow = {
  id: string
  user_id: string
  token_hash: string
  mobile_number: string
  purpose: SmsVerificationPurpose
  attempts: number
  expires_at: string
  consumed_at: string | null
  created_at: string
}

const TABLE = "drive_sms_verification_tokens"
const CODE_TTL_MINUTES = 5

export function normalizeSriLankaMobile(value: string) {
  const digits = value.replace(/\D/g, "")
  if (digits.startsWith("94") && digits.length === 11) return `+${digits}`
  if (digits.startsWith("0") && digits.length === 10) return `+94${digits.slice(1)}`
  if (digits.length === 9 && digits.startsWith("7")) return `+94${digits}`
  throw new Error("Enter a valid Sri Lankan mobile number")
}

function hashCode(userId: string, mobileNumber: string, purpose: SmsVerificationPurpose, code: string): string {
  return crypto
    .createHash("sha256")
    .update(`${userId}:${mobileNumber}:${purpose}:${code}`)
    .digest("hex")
}

function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0")
}

async function sendTextLkSms(to: string, message: string) {
  const token = process.env.TEXTLK_API_TOKEN || process.env.TEXT_LK_API_TOKEN
  const senderId = process.env.TEXTLK_SENDER_ID || process.env.TEXT_LK_SENDER_ID || "Drive"
  if (!token) throw new Error("TEXTLK_API_TOKEN is not configured")

  const res = await fetch("https://app.text.lk/api/v3/sms/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      recipient: to.replace(/^\+/, ""),
      sender_id: senderId,
      type: "plain",
      message,
    }),
  })

  const data: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message?: unknown }).message)
        : "Unable to send SMS verification code"
    throw new Error(message)
  }
}

export async function createSmsVerificationCode(input: {
  userId: string
  mobileNumber: string
  purpose: SmsVerificationPurpose
}) {
  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString()
  const mobileNumber = normalizeSriLankaMobile(input.mobileNumber)

  await withDbTransaction(async (client) => {
    await client.query(`delete from public.${TABLE} where user_id=$1 and purpose=$2 and consumed_at is null`, [input.userId, input.purpose])
    await client.query(`
      insert into public.${TABLE}(id,user_id,token_hash,mobile_number,purpose,attempts,expires_at)
      values($1,$2,$3,$4,$5,0,$6)
    `, [crypto.randomUUID(), input.userId, hashCode(input.userId, mobileNumber, input.purpose, code), mobileNumber, input.purpose, expiresAt])
  })

  return { code, expiresAt, mobileNumber }
}

export async function sendSmsVerificationCode(input: {
  userId: string
  mobileNumber: string
  purpose: SmsVerificationPurpose
}) {
  const { code, expiresAt, mobileNumber } = await createSmsVerificationCode(input)
  await sendTextLkSms(mobileNumber, `Your Drive verification code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`)
  return { expiresAt, mobileNumber }
}

export async function verifySmsCode(input: {
  userId: string
  mobileNumber: string
  code: string
  purpose: SmsVerificationPurpose
  consume?: boolean
}): Promise<PublicUser> {
  const code = input.code.replace(/\D/g, "")
  if (code.length !== 6) throw new Error("Enter the 6-digit verification code")

  const mobileNumber = normalizeSriLankaMobile(input.mobileNumber)
  const outcome = await withDbTransaction(async (client) => {
    const result = await client.query<SmsVerificationRow>(`
      select * from public.${TABLE}
      where user_id=$1 and mobile_number=$2 and purpose=$3 and consumed_at is null
      order by created_at desc limit 1 for update
    `, [input.userId, mobileNumber, input.purpose])
    const row = result.rows[0]
    if (!row) return { error: "Verification code is invalid" }
    if (new Date(row.expires_at).getTime() < Date.now()) return { error: "Verification code has expired" }
    if (row.attempts >= 5) return { error: "Verification code has too many failed attempts. Request a new code." }
    const expected = Buffer.from(hashCode(input.userId, mobileNumber, input.purpose, code), "hex")
    const actual = Buffer.from(row.token_hash, "hex")
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      await client.query(`update public.${TABLE} set attempts=attempts+1 where id=$1`, [row.id])
      return { error: "Verification code is invalid" }
    }
    const userResult = await client.query<{ id: string }>(`select id from public.drive_users where id=$1 for update`, [row.user_id])
    if (!userResult.rows[0]) return { error: "User not found" }
    const consumedAt = new Date().toISOString()
    if (input.consume !== false) {
      const consumed = await client.query(`update public.${TABLE} set consumed_at=$2 where id=$1 and consumed_at is null`, [row.id, consumedAt])
      if (consumed.rowCount !== 1) return { error: "Verification code has already been used" }
      if (input.purpose === "mobile-setup") {
        await client.query(`update public.drive_users set mobile_number=$2,mobile_verified=true,mobile_verified_at=$3,updated_at=now() where id=$1`, [row.user_id, mobileNumber, consumedAt])
      }
    }
    return { userId: row.user_id }
  })
  if ("error" in outcome) throw new Error(outcome.error)
  const user = await findUserById(outcome.userId)
  if (!user) throw new Error("User not found")
  return toPublicUser(user)
}
