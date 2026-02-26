/** Internal DB row types — snake_case matching Supabase columns. */

export interface AgentRow {
  id: string
  public_key: string
  endpoint: string | null
  name: string | null
  capabilities: string[]
  metadata: Record<string, unknown>
  parent_id: string | null
  created_at: string
  last_seen_at: string
}

export interface PolicyRow {
  id: string
  name: string
  description: string | null
  intent: string
  formal_spec: Record<string, unknown>
  version: number
  status: string
  billing: string
  tier2_used: boolean
  translation_model: string | null
  cross_validator: string | null
  cross_validation: Record<string, unknown> | null
  argus_budget: number | null
  argus_coverage: number | null
  argus_exploits: Record<string, unknown>[] | null
  parent_version: string | null
  created_by: string | null
  created_at: string
  activated_at: string | null
  deprecated_at: string | null
}

export interface EscrowRow {
  id: string
  contract_address: string | null
  stripe_escrow_id: string | null
  buyer_id: string
  seller_id: string
  amount_cents: number
  seller_collateral: number
  task_hash: string
  task_spec: Record<string, unknown>
  policy_id: string | null
  verification_method: string
  dispute_resolution: string
  status: string
  proof: string | null
  created_at: string
  funded_at: string | null
  completed_at: string | null
  expires_at: string
  delivery_attempts: number
  timeout_seconds: number
  // Phase 4: on-chain escrow fields
  funding_mode: 'stripe' | 'onchain'
  buyer_address: string | null
  seller_address: string | null
  buyer_funded: boolean
  seller_funded: boolean
  chain_id: number | null
  tx_hash: string | null
}

export interface PaymentChannelRow {
  id: string
  buyer_id: string
  seller_id: string
  buyer_address: string
  seller_address: string
  channel_address: string | null
  deposit_amount: number
  spent_amount: number
  chain_id: number
  status: string
  expiry_at: string
  created_at: string
}

export interface VerificationRow {
  id: string
  escrow_id: string
  method: string
  policy_id: string | null
  result: string
  constraints_total: number | null
  constraints_passed: number | null
  failure_details: Record<string, unknown> | null
  proof_hash: string | null
  gateway_signature: string
  verified_at: string
}

export interface DisputeRow {
  id: string
  escrow_id: string
  initiator_id: string
  reason: string | null
  evidence_hash: string | null
  arbitrator_id: string | null
  ruling: string | null
  status: string
  created_at: string
  resolved_at: string | null
}

export interface RefinementRow {
  id: string
  policy_id: string
  status: string  // running | complete | failed
  budget: number
  current_round: number
  last_exploit_round: number
  consecutive_clean: number
  working_spec: Record<string, unknown>
  exploits: Record<string, unknown>[]
  coverage: number | null
  tier2_introduced: boolean
  error_message: string | null
  created_at: string
  completed_at: string | null
}

export interface AttestationRow {
  id: string
  author_id: string
  subject_id: string
  escrow_id: string | null
  outcome: string
  verification_method: string | null
  signature: string
  nostr_event_id: string | null
  created_at: string
}

// Phase 6: Oracle Verification

export interface OraclePoolRow {
  id: string
  agent_id: string
  status: 'active' | 'withdrawn'
  capabilities: string[]
  tasks_completed: number
  accuracy_score: number
  created_at: string
  updated_at: string
}

export interface OracleTaskRow {
  id: string
  escrow_id: string
  status: 'pending' | 'voting' | 'decided' | 'expired' | 'failed'
  quorum: number
  total_oracles: number
  consensus: 'pass' | 'fail' | 'no_consensus' | null
  deliverable: Record<string, unknown>
  task_spec: string | null
  policy_id: string | null
  votes_pass: number
  votes_fail: number
  expires_at: string
  decided_at: string | null
  created_at: string
}

export interface OracleVoteRow {
  id: string
  oracle_task_id: string
  oracle_id: string
  agent_id: string
  status: 'pending' | 'submitted' | 'expired'
  verdict: 'pass' | 'fail' | null
  rationale: string | null
  submitted_at: string | null
  created_at: string
}

export interface OraclePaymentRow {
  id: string
  oracle_task_id: string
  oracle_id: string
  agent_id: string
  amount_cents: number
  status: 'pending' | 'paid'
  created_at: string
}
