import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import {
  createUser,
  findUserByEmail,
  findUserById,
  findUserByUsername,
  updateUser,
} from "@/lib/users-store"

type GoogleUserInfo = {
  sub: string
  name?: string
  given_name?: string
  family_name?: string
  picture?: string
  email?: string
  email_verified?: boolean
}

function getEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set`)
  }
  return value
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4))
  return Buffer.from(normalized + pad, "base64")
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

type OAuthStatePayload = {
  nonce: string
  mode?: string
  redirect?: string
  ts?: number
}

function parseAndValidateState(state: string, secret: string): OAuthStatePayload {
  const [payloadPart, sigPart] = state.split(".")
  if (!payloadPart || !sigPart) {
    throw new Error("Invalid OAuth state")
  }

  const payloadJson = base64UrlDecode(payloadPart).toString("utf8")
  const providedSig = base64UrlDecode(sigPart)

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payloadJson)
    .digest()

  if (!timingSafeEqual(providedSig, expectedSig)) {
    throw new Error("Invalid OAuth state")
  }

  const parsed = JSON.parse(payloadJson) as OAuthStatePayload
  const ts = typeof parsed.ts === "number" ? parsed.ts : 0
  const ageMs = Date.now() - ts
  if (!ts || ageMs < 0 || ageMs > 10 * 60 * 1000) {
    throw new Error("OAuth state expired. Please try again.")
  }

  return parsed
}

async function generateAvailableUsername(base: string): Promise<string> {
  const safeBase = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "") || "user"

  let counter = 0
  // Try base, then base1, base2, ...
  while (true) {
    const username = counter === 0 ? safeBase : `${safeBase}${counter}`
    const existing = await findUserByUsername(username)
    if (!existing) {
      return username
    }
    counter++
  }
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")

  if (!code || !state) {
    return NextResponse.json(
      { error: "Invalid OAuth state" },
      { status: 400 }
    )
  }

  const origin = url.origin
  const callbackUrl = new URL("/api/auth/google/callback", origin).toString()

  try {
    const clientId = getEnv("GOOGLE_CLIENT_ID")
    const clientSecret = getEnv("GOOGLE_CLIENT_SECRET")

    const statePayload = parseAndValidateState(state, clientSecret)
    const mode = statePayload.mode ?? "login"
    const redirectCookie = statePayload.redirect

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl,
        grant_type: "authorization_code",
      }),
    })

    const tokenData = await tokenRes.json()
    if (!tokenRes.ok) {
      const message =
        typeof tokenData.error_description === "string"
          ? tokenData.error_description
          : "Failed to exchange code for tokens"
      throw new Error(message)
    }

    const accessToken = tokenData.access_token as string | undefined
    if (!accessToken) {
      throw new Error("No access token received from Google")
    }

    const userInfoRes = await fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    )

    const userInfo = (await userInfoRes.json()) as GoogleUserInfo
    if (!userInfoRes.ok) {
      throw new Error("Failed to fetch user info from Google")
    }

    if (!userInfo.email || !userInfo.email_verified) {
      throw new Error("Google account email is not available or not verified")
    }

    const email = userInfo.email.toLowerCase()
    const usernameCandidate = email.split("@")[0]

    let user

    if (mode === "link") {
      const actorId = request.cookies.get("sessionUserId")?.value
      if (!actorId) {
        throw new Error("You must be signed in to link a Google account")
      }
      const actor = await findUserById(actorId)
      if (!actor) {
        throw new Error("Your session is no longer valid")
      }
      if (actor.email.toLowerCase() !== email) {
        throw new Error(
          "Google email does not match your account email. Please use the same email to link."
        )
      }

      user = await updateUser(actor.id, {
        googleLinked: true,
        googleSub: userInfo.sub ?? actor.googleSub,
      })
    } else {
      const existing = await findUserByEmail(email)
      if (!existing) {
        const username = await generateAvailableUsername(usernameCandidate)
        const randomPassword = crypto.randomBytes(32).toString("hex")
        user = await createUser({
          name:
            [userInfo.given_name, userInfo.family_name]
              .filter(Boolean)
              .join(" ") || userInfo.name || email,
          username,
          email,
          password: randomPassword,
          profileImageUrl: userInfo.picture,
          googleLinked: true,
          googleSub: userInfo.sub,
          passwordSource: "google-generated",
        })
      } else {
        user = await updateUser(existing.id, {
          googleLinked: true,
          googleSub: userInfo.sub ?? existing.googleSub,
        })
      }
    }

    const finalUrl = new URL("/auth/google/complete", origin)
    if (redirectCookie) {
      finalUrl.searchParams.set("redirect", redirectCookie)
    }

    const response = NextResponse.redirect(finalUrl)

    response.cookies.set("sessionUserId", user.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    })

    return response
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Google authentication failed" },
      { status: 400 }
    )
  }
}
