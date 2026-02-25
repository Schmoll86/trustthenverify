import { createClient, SupabaseClient } from '@supabase/supabase-js'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  GATEWAY_PRIVATE_KEY: string
  SANDBOX_KEYS: string // comma-separated valid sandbox keys
  STRIPE_SECRET_KEY: string
  AI: unknown
}

/** Create a Supabase client per-request from Workers env bindings. */
export function createDb(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
}
