import { createClient, type SupabaseClient } from "@supabase/supabase-js"

function getEnv(name: string): string | undefined {
  const value = process.env[name]
  return value && value.trim().length > 0 ? value : undefined
}

export function getSupabaseUrl(): string {
  const url = getEnv("NEXT_PUBLIC_SUPABASE_URL") ?? getEnv("SUPABASE_URL")
  if (!url) {
    throw new Error("Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)")
  }
  return url
}

export function getSupabaseAnonKey(): string {
  const key =
    getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY") ??
    getEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY") ??
    getEnv("SUPABASE_ANON_KEY") ??
    getEnv("SUPABASE_PUBLISHABLE_KEY") ??
    getEnv("SUPABASE_KEY")
  if (!key) {
    throw new Error(
      "Missing Supabase key (set NEXT_PUBLIC_SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY)"
    )
  }
  return key
}

export function getSupabaseServiceRoleKey(): string | undefined {
  return (
    getEnv("SUPABASE_SERVICE_ROLE_KEY") ??
    getEnv("SUPABASE_SECRET_KEY") ??
    getEnv("SUPABASE_SERVICE_KEY")
  )
}

let supabaseBrowserClient: SupabaseClient | undefined
let supabaseServerClient: SupabaseClient | undefined

export function getSupabaseBrowserClient(): SupabaseClient {
  if (!supabaseBrowserClient) {
    supabaseBrowserClient = createClient(getSupabaseUrl(), getSupabaseAnonKey())
  }
  return supabaseBrowserClient
}

export function getSupabaseServerClient(): SupabaseClient {
  if (!supabaseServerClient) {
    const key = getSupabaseServiceRoleKey() ?? getSupabaseAnonKey()
    supabaseServerClient = createClient(getSupabaseUrl(), key)
  }
  return supabaseServerClient
}
