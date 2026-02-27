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
  NOSTR_RELAY_URLS?: string  // optional, comma-separated relay WebSocket URLs
  OPENROUTER_API_KEY?: string
  TRANSLATOR_MODEL?: string    // default: 'moonshotai/kimi-k2.5'
  CROSS_VALIDATOR_MODEL?: string // default: 'google/gemini-2.5-flash'
  // Phase 4: on-chain escrow (Base L2)
  BASE_RPC_URL?: string         // default: 'https://mainnet.base.org'
  ESCROW_FACTORY_ADDRESS?: string
  BASE_CHAIN_ID?: string        // default: '8453' (Base mainnet)
  GATEWAY_EOA_PRIVATE_KEY?: string  // secp256k1 key for Ethereum tx signing
  // Phase 6: Oracle verification
  ORACLE_FEE_CENTS?: string           // default: '100' ($1.00)
  ORACLE_VOTING_WINDOW_SECONDS?: string // default: '1800' (30 min)
  // Phase 3: Auto-refinement
  AUTO_REFINE_DISPUTE_THRESHOLD?: string // default: '3'
  // Rate limiting
  RATE_LIMIT_KV?: KVNamespace
  // Arbitration
  ARBITRATION_MODEL?: string           // default: 'google/gemini-2.5-flash'
}

/** Create a Supabase client per-request from Workers env bindings. */
export function createDb(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
}
