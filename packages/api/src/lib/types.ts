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
