import crypto from "crypto"
import { getSupabaseServerClient } from "./supabase"
import { findUserById, toPublicUser, updateUser, type PublicUser } from "./users-store"

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
  const supabase = getSupabaseServerClient()
  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString()
  const normalizedEmail = normalizeEmail(email)

  await supabase
    .from(TABLE)
    .delete()
    .eq("user_id", userId)
    .eq("purpose", purpose)
    .is("consumed_at", null)

  const { error } = await supabase.from(TABLE).insert({
    id: crypto.randomUUID(),
    user_id: userId,
    token_hash: hashCode(userId, normalizedEmail, purpose, code),
    email: normalizedEmail,
    purpose,
    attempts: 0,
    expires_at: expiresAt,
  })
  if (error) throw new Error(error.message)

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

  const supabase = getSupabaseServerClient()
  const email = normalizeEmail(input.email)
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("email", email)
    .eq("purpose", input.purpose)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)

  if (error) throw new Error(error.message)
  const row = (data as VerificationRow[])[0]
  if (!row) throw new Error("Verification code is invalid")
  if (Date.parse(row.expires_at) < Date.now()) {
    throw new Error("Verification code has expired")
  }
  if ((row.attempts ?? 0) >= 5) {
    throw new Error("Verification code has too many failed attempts. Request a new code.")
  }
  const tokenHash = hashCode(row.user_id, email, input.purpose, code)
  if (row.token_hash !== tokenHash) {
    await supabase
      .from(TABLE)
      .update({ attempts: (row.attempts ?? 0) + 1 })
      .eq("id", row.id)
    throw new Error("Verification code is invalid")
  }

  const user = await findUserById(row.user_id)
  if (!user) throw new Error("User not found")
  if (user.email.toLowerCase() !== email) {
    throw new Error("Verification email no longer matches this account")
  }

  const consumedAt = new Date().toISOString()
  if (input.consume !== false) {
    await supabase
      .from(TABLE)
      .update({ consumed_at: consumedAt })
      .eq("id", row.id)
  }

  if (input.consume !== false && input.purpose === "signup" && !user.emailVerified) {
    const updated = await updateUser(user.id, {
      emailVerified: true,
      emailVerifiedAt: consumedAt,
    })
    return toPublicUser(updated)
  }

  return toPublicUser(user)
}
