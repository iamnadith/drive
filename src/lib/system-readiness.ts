import { queryDb } from "@/lib/db"

export type RequirementStatus = {
  id: string
  label: string
  description: string
  configured: boolean
  variables: string[]
  error?: string
}

function present(...names: string[]) {
  return names.some((name) => String(process.env[name] || "").trim().length > 0)
}

export function authCapabilities() {
  return {
    google: present("GOOGLE_CLIENT_ID") && present("GOOGLE_CLIENT_SECRET"),
    sms: present("TEXTLK_API_TOKEN", "TEXT_LK_API_TOKEN"),
  }
}

export async function getSystemReadiness() {
  let databaseConnected = false
  let databaseError: string | undefined
  const databaseConfigured = present("POSTGRES_URL_NON_POOLING", "POSTGRES_URL", "POSTGRES_PRISMA_URL")
  if (databaseConfigured) {
    try { await queryDb("select 1 as ready"); databaseConnected = true }
    catch (error) { databaseError = error instanceof Error ? error.message : "Database connection failed" }
  }
  const requirements: RequirementStatus[] = [
    { id: "database", label: "PostgreSQL database", description: "Primary durable state shared by the panel and Workers.", configured: databaseConfigured && databaseConnected, variables: ["POSTGRES_URL_NON_POOLING or POSTGRES_URL"], error: databaseError },
    { id: "database-ssl", label: "PostgreSQL transport security", description: "Explicitly controls encrypted PostgreSQL connections for the panel and every Worker.", configured: present("POSTGRES_SSL", "DISABLE_POSTGRES_SSL"), variables: ["POSTGRES_SSL=true"] },
    { id: "email", label: "Email gateway", description: "Required to verify the first administrator and recover accounts.", configured: present("RESEND_API_KEY") && present("RESEND_FROM_EMAIL", "RESEND_FROM"), variables: ["RESEND_API_KEY", "RESEND_FROM_EMAIL"] },
    { id: "origin", label: "Public application URL", description: "Canonical HTTPS origin injected into every Worker.", configured: present("APP_URL", "NEXT_PUBLIC_APP_URL", "VERCEL_PROJECT_PRODUCTION_URL"), variables: ["NEXT_PUBLIC_APP_URL"] },
    { id: "encryption", label: "Credential encryption", description: "A stable server-only key protects saved Cloudflare credentials.", configured: present("CLOUDFLARE_TOKEN_ENCRYPTION_KEY", "AUTH_SECRET", "NEXTAUTH_SECRET"), variables: ["CLOUDFLARE_TOKEN_ENCRYPTION_KEY or AUTH_SECRET"] },
  ]
  return { ready: requirements.every((item) => item.configured), requirements, capabilities: authCapabilities() }
}
