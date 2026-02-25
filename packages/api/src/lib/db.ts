import { createClient, SupabaseClient } from '@supabase/supabase-js'

export interface WorkersAI {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>
}

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  GATEWAY_PRIVATE_KEY: string
  SANDBOX_KEYS: string // comma-separated valid sandbox keys
  STRIPE_SECRET_KEY: string
  AI: WorkersAI
  QUEUE: { send(message: unknown): Promise<void> }
  OPENROUTER_API_KEY?: string
  TRANSLATOR_MODEL?: string    // default: 'moonshotai/kimi-k2.5'
  CROSS_VALIDATOR_MODEL?: string // default: 'google/gemini-2.5-flash'
}

/** Create a Supabase client per-request from Workers env bindings. */
export function createDb(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
}
