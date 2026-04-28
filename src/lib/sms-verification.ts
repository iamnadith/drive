import crypto from "crypto"
import { getSupabaseServerClient } from "./supabase"
import { findUserById, toPublicUser, updateUser, type PublicUser } from "./users-store"
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
  const supabase = getSupabaseServerClient()
  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString()
  const mobileNumber = normalizeSriLankaMobile(input.mobileNumber)

  await supabase
    .from(TABLE)
    .delete()
    .eq("user_id", input.userId)
    .eq("purpose", input.purpose)
    .is("consumed_at", null)

  const { error } = await supabase.from(TABLE).insert({
    id: crypto.randomUUID(),
    user_id: input.userId,
    token_hash: hashCode(input.userId, mobileNumber, input.purpose, code),
    mobile_number: mobileNumber,
    purpose: input.purpose,
    attempts: 0,
    expires_at: expiresAt,
  })
  if (error) throw new Error(error.message)

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

  const supabase = getSupabaseServerClient()
  const mobileNumber = normalizeSriLankaMobile(input.mobileNumber)
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("user_id", input.userId)
    .eq("mobile_number", mobileNumber)
    .eq("purpose", input.purpose)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)

  if (error) throw new Error(error.message)
  const row = (data as SmsVerificationRow[])[0]
  if (!row) throw new Error("Verification code is invalid")
  if (Date.parse(row.expires_at) < Date.now()) throw new Error("Verification code has expired")
  if ((row.attempts ?? 0) >= 5) {
    throw new Error("Verification code has too many failed attempts. Request a new code.")
  }
  const tokenHash = hashCode(input.userId, mobileNumber, input.purpose, code)
  if (row.token_hash !== tokenHash) {
    await supabase.from(TABLE).update({ attempts: (row.attempts ?? 0) + 1 }).eq("id", row.id)
    throw new Error("Verification code is invalid")
  }

  const user = await findUserById(row.user_id)
  if (!user) throw new Error("User not found")

  const consumedAt = new Date().toISOString()
  if (input.consume !== false) {
    await supabase.from(TABLE).update({ consumed_at: consumedAt }).eq("id", row.id)
  }

  if (input.consume !== false && input.purpose === "mobile-setup") {
    const updated = await updateUser(user.id, {
      mobileNumber,
      mobileVerified: true,
      mobileVerifiedAt: consumedAt,
    })
    return toPublicUser(updated)
  }

  return toPublicUser(user)
}
