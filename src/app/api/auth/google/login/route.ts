import { NextResponse } from "next/server"
import crypto from "crypto"
import { getPublicOrigin } from "@/lib/public-origin"

function getEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set`)
  }
  return value
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

export async function GET(request: Request) {
  try {
    // Ensure env exists (throws if not)
    getEnv("GOOGLE_CLIENT_ID")
    const stateSecret = getEnv("GOOGLE_CLIENT_SECRET")

    const url = new URL(request.url)
    const mode = url.searchParams.get("mode") ?? "login"
    const redirect = url.searchParams.get("redirect") ?? "/"

    const origin = getPublicOrigin(request)
    const originUrl = new URL(origin)
    const isLocalhost =
      originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1"
    if (originUrl.protocol === "http:" && !isLocalhost) {
      throw new Error(
        `Google OAuth requires https redirect URIs (except localhost). Set APP_ORIGIN to your https site URL; current origin is ${origin}.`
      )
    }
    const callbackUrl = new URL("/api/auth/google/callback", origin).toString()

    const statePayload = JSON.stringify({
      nonce: crypto.randomUUID(),
      mode,
      redirect,
      ts: Date.now(),
    })
    const signature = crypto
      .createHmac("sha256", stateSecret)
      .update(statePayload)
      .digest()
    const state = `${base64UrlEncode(statePayload)}.${base64UrlEncode(signature)}`

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID as string,
      redirect_uri: callbackUrl,
      response_type: "code",
      scope: "openid email profile",
      access_type: "offline",
      prompt: "select_account",
      state,
    })

    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`

    const response = NextResponse.redirect(googleAuthUrl)

    return response
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "Unable to start Google login" },
      { status: 400 }
    )
  }
}
