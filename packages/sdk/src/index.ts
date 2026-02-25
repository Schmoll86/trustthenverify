// TrustThenVerify SDK — @trustthenverify/sdk
// v2: Escrow + Verification Protocol
//
// Zero-config reads require no auth.
// Writes require secp256k1 signature (§9.2).

import {
  generateKeypair as genKp,
  signRequest,
  verifySignature,
  sha256Hex,
  buildCanonicalString,
} from './crypto.js'

export {
  signRequest,
  verifySignature,
  sha256Hex,
  buildCanonicalString,
} from './crypto.js'

import { ObservationStore } from './observations.js'
export { ObservationStore } from './observations.js'
export type { Observation } from './observations.js'

const DEFAULT_API_URL = 'https://api.trustthenverify.com/v2'
const SANDBOX_API_URL = 'https://sandbox.trustthenverify.com/v2'

// ─── Types (from SPEC-v2 §6.3 schema) ────────────────────────────────────────

export interface Agent {
  id: string
  publicKey: string
  endpoint: string | null
  name: string | null
  capabilities: string[]
  metadata: Record<string, unknown>
  parentId: string | null
  createdAt: string
  lastSeenAt: string
}

export interface Policy {
  id: string
  name: string
  description: string | null
  intent: string
  formalSpec: FormalSpec
  version: number
  status: 'draft' | 'validated' | 'approved' | 'active' | 'deprecated'
  billing: 'creator' | 'platform' | 'marketplace'
  tier2Used: boolean
  translationModel: string | null
  crossValidator: string | null
  crossValidation: Record<string, unknown> | null
  argusBudget: number | null
  argusCoverage: number | null
  argusExploits: Record<string, unknown>[] | null
  parentVersion: string | null
  createdBy: string | null
  createdAt: string
  activatedAt: string | null
  deprecatedAt: string | null
}

// §3.1.1 — formal_spec JSONB structure
export interface FormalSpec {
  version: number
  constraints: FormalConstraint[]
}

export interface FormalConstraint {
  id: string
  type: string          // §3.1.2 constraint types (count, range, format, etc.)
  target: string        // JSONPath-subset notation (e.g., "$.results[*].url")
  params: Record<string, unknown>
  clauseRef?: string    // back-reference to original NL clause
}

export interface CoverageMap {
  clauses: CoverageClause[]
  uncoveredCount: number
}

export interface CoverageClause {
  index: number
  text: string
  constraintIds: string[]
  status: 'covered' | 'partial' | 'uncovered'
  note: string | null
}

export type VerificationMethod =
  | 'hash_match'
  | 'schema_validation'
  | 'automated_reasoning'
  | 'oracle_consensus'
  | 'buyer_confirm'
  | 'zkml_proof'

export interface Escrow {
  id: string
  contractAddress: string | null
  stripeEscrowId: string | null
  buyerId: string
  sellerId: string
  amountCents: number
  sellerCollateral: number
  taskHash: string
  taskSpec: Record<string, unknown>
  policyId: string | null
  verificationMethod: VerificationMethod
  disputeResolution: 'burn' | 'arbitrate'
  status: 'proposed' | 'accepted' | 'funded' | 'active' | 'delivered' | 'released' | 'failed' | 'disputed' | 'burned' | 'resolved' | 'expired'
  proof: string | null
  createdAt: string
  fundedAt: string | null
  completedAt: string | null
  expiresAt: string
}

export type VerificationOutcome = 'pass' | 'fail' | 'pass_partial' | 'error'

export interface VerificationResult {
  id: string
  escrowId: string
  method: string
  policyId: string | null
  result: VerificationOutcome
  constraintsTotal: number
  constraintsPassed: number
  failureDetails: unknown | null
  proofHash: string | null
  gatewaySignature: string
  verifiedAt: string
}

export interface Attestation {
  id: string
  authorId: string
  subjectId: string
  escrowId: string | null
  outcome: string
  verificationMethod: string | null
  signature: string
  nostrEventId: string | null
  createdAt: string
}

export interface Dispute {
  id: string
  escrowId: string
  initiatorId: string
  reason: string | null
  evidenceHash: string | null
  arbitratorId: string | null
  ruling: string | null
  status: 'open' | 'resolved'
  createdAt: string
  resolvedAt: string | null
}

export interface CollateralSuggestion {
  suggestedRatio: number
  confidence: 'low' | 'medium' | 'high'
  dataPoints: number
}

export interface Keypair {
  publicKey: string   // hex-encoded secp256k1
  privateKey: string  // hex-encoded — store securely, never send to server
}

// ─── Keypair generation (client-side only — §2.1) ────────────────────────────

export function generateKeypair(): Keypair {
  return genKp()
}

// ─── Quick Start (§10.6) ────────────────────────────────────────────────────

export interface QuickStartOptions {
  /** Use sandbox environment (default: true) */
  sandbox?: boolean
  /** Sandbox API key. Falls back to TRUSTTHENVERIFY_SANDBOX_KEY env var. */
  sandboxKey?: string
  /** Override API URL */
  apiUrl?: string
  /** Agent name */
  name?: string
  /** Agent capabilities */
  capabilities?: string[]
}

/**
 * One-line setup: generates keypair, registers agent, returns a ready-to-use
 * TrustProtocol instance. Designed for sandbox experimentation — go from
 * `npm install` to a test transaction in under 5 minutes.
 */
export async function quickStart(options?: QuickStartOptions): Promise<TrustProtocol> {
  const sandbox = options?.sandbox ?? true
  const keypair = generateKeypair()

  await createAgent({
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    name: options?.name,
    capabilities: options?.capabilities,
    apiUrl: options?.apiUrl,
    sandbox,
    sandboxKey: options?.sandboxKey,
  })

  return new TrustProtocol({
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    apiUrl: options?.apiUrl,
    sandbox,
    sandboxKey: options?.sandboxKey,
  })
}

// ─── Zero-config reads (no auth) ────────────────────────────────────────────

export async function lookupAgent(
  pubkey: string,
  options?: { apiUrl?: string }
): Promise<Agent> {
  const baseUrl = options?.apiUrl ?? DEFAULT_API_URL
  const res = await fetch(`${baseUrl}/agents/${pubkey}`)
  if (!res.ok) throw new Error(`Agent not found: ${pubkey}`)
  return (await res.json() as { data: Agent }).data
}

export async function searchAgents(
  capabilities: string[],
  options?: { match?: 'any' | 'all'; cursor?: string; apiUrl?: string }
): Promise<{ agents: Agent[]; cursor: string | null }> {
  const baseUrl = options?.apiUrl ?? DEFAULT_API_URL
  const params = new URLSearchParams({
    capabilities: capabilities.join(','),
    match: options?.match ?? 'any',
  })
  if (options?.cursor) params.set('cursor', options.cursor)
  const res = await fetch(`${baseUrl}/agents/search?${params}`)
  if (!res.ok) throw new Error('Agent search failed')
  const json = await res.json() as { data: Agent[]; meta: { cursor: string | null } }
  return { agents: json.data, cursor: json.meta.cursor }
}

export async function queryAttestations(
  pubkey: string,
  options?: { limit?: number; apiUrl?: string }
): Promise<Attestation[]> {
  const baseUrl = options?.apiUrl ?? DEFAULT_API_URL
  const params = options?.limit ? `?limit=${options.limit}` : ''
  const res = await fetch(`${baseUrl}/attestations/${pubkey}${params}`)
  if (!res.ok) throw new Error(`Attestation query failed`)
  return (await res.json() as { data: Attestation[] }).data
}

export async function getPolicy(
  policyId: string,
  options?: { apiUrl?: string }
): Promise<Policy> {
  const baseUrl = options?.apiUrl ?? DEFAULT_API_URL
  const res = await fetch(`${baseUrl}/policies/${policyId}`)
  if (!res.ok) throw new Error(`Policy not found: ${policyId}`)
  return (await res.json() as { data: Policy }).data
}

export async function getPolicyTemplates(
  options?: { apiUrl?: string }
): Promise<Policy[]> {
  const baseUrl = options?.apiUrl ?? DEFAULT_API_URL
  const res = await fetch(`${baseUrl}/policies/templates`)
  if (!res.ok) throw new Error('Failed to fetch policy templates')
  return (await res.json() as { data: Policy[] }).data
}

// ─── Agent registration (§10.2) ──────────────────────────────────────────────

export async function createAgent(params: {
  publicKey: string
  privateKey: string
  endpoint?: string
  name?: string
  capabilities?: string[]
  apiUrl?: string
  sandbox?: boolean
  sandboxKey?: string
}): Promise<Agent> {
  const isSandbox = params.sandbox ?? false
  const baseUrl = params.apiUrl ?? (isSandbox ? SANDBOX_API_URL : DEFAULT_API_URL)
  const body = JSON.stringify({
    publicKey: params.publicKey,
    endpoint: params.endpoint,
    name: params.name,
    capabilities: params.capabilities ?? [],
  })

  const path = '/agents'

  let headers: Record<string, string>

  if (isSandbox) {
    const key = params.sandboxKey
      ?? (typeof process !== 'undefined' ? process.env?.TRUSTTHENVERIFY_SANDBOX_KEY : undefined)
    headers = {
      'Content-Type': 'application/json',
      'X-Sandbox-Key': key ?? '',
    }
  } else {
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = await signRequest(params.privateKey, 'POST', path, body, timestamp)
    headers = {
      'Content-Type': 'application/json',
      'X-Agent-Pubkey': params.publicKey,
      'X-Agent-Timestamp': String(timestamp),
      'X-Agent-Signature': signature,
    }
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body,
  })
  if (!res.ok) throw new Error('Registration failed')
  return (await res.json() as { data: Agent }).data
}

// ─── TrustProtocol (authenticated — §10.3, §10.4) ───────────────────────────

export interface TrustProtocolOptions {
  publicKey: string
  privateKey: string
  apiUrl?: string
  sandbox?: boolean
  sandboxKey?: string
}

export class TrustProtocol {
  private publicKey: string
  private privateKey: string
  private baseUrl: string
  private sandbox: boolean
  private sandboxKey: string | undefined
  readonly observations: ObservationStore

  constructor(options: TrustProtocolOptions) {
    this.publicKey = options.publicKey
    this.privateKey = options.privateKey
    this.sandbox = options.sandbox ?? false
    this.sandboxKey = options.sandboxKey
    this.baseUrl = options.apiUrl
      ?? (this.sandbox ? SANDBOX_API_URL : DEFAULT_API_URL)
    this.observations = new ObservationStore()
  }

  private async signedHeaders(method: string, path: string, body: string): Promise<Record<string, string>> {
    if (this.sandbox) {
      const key = this.sandboxKey
        ?? (typeof process !== 'undefined' ? process.env?.TRUSTTHENVERIFY_SANDBOX_KEY : undefined)
      return {
        'X-Sandbox-Key': key ?? '',
        'Content-Type': 'application/json',
      }
    }

    const timestamp = Math.floor(Date.now() / 1000)
    const signature = await signRequest(this.privateKey, method, path, body, timestamp)
    return {
      'X-Agent-Pubkey': this.publicKey,
      'X-Agent-Timestamp': String(timestamp),
      'X-Agent-Signature': signature,
      'Content-Type': 'application/json',
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: await this.signedHeaders('GET', path, ''),
    })
    const json = await res.json() as { data: T; error?: { message: string } }
    if (!res.ok) throw new Error(json.error?.message ?? `Request failed: ${res.status}`)
    return json.data
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const bodyStr = JSON.stringify(body)
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: await this.signedHeaders('POST', path, bodyStr),
      body: bodyStr,
    })
    const json = await res.json() as { data: T; error?: { message: string } }
    if (!res.ok) throw new Error(json.error?.message ?? `Request failed: ${res.status}`)
    return json.data
  }

  // ── Identity (§2.1) ──────────────────────────────────────────────────────

  async verify(counterpartyPubkey: string): Promise<{ verified: boolean }> {
    return this.post(`/agents/${counterpartyPubkey}/verify`, {})
  }

  async spawnAgent(params: {
    publicKey: string
    endpoint?: string
    name?: string
    capabilities?: string[]
  }): Promise<Agent> {
    return this.post(`/agents/${this.publicKey}/spawn`, {
      publicKey: params.publicKey,
      endpoint: params.endpoint,
      name: params.name,
      capabilities: params.capabilities ?? [],
    })
  }

  // ── Policies (§10.3) ─────────────────────────────────────────────────────

  async createPolicy(params: {
    name: string
    intent: string
    description?: string
    billing?: Policy['billing']
  }): Promise<Policy> {
    return this.post('/policies', params)
  }

  async getCoverage(policyId: string): Promise<CoverageMap> {
    return this.get(`/policies/${policyId}/coverage`)
  }

  async revisePolicy(policyId: string, params: { intent: string }): Promise<Policy> {
    return this.post(`/policies/${policyId}/revise`, params)
  }

  async activatePolicy(policyId: string): Promise<Policy> {
    return this.post(`/policies/${policyId}/activate`, {})
  }

  async refinePolicy(policyId: string, params?: { budget?: number }): Promise<{
    refinementId: string
    status: 'running'
  }> {
    return this.post(`/policies/${policyId}/refine`, params ?? {})
  }

  async refinementStatus(policyId: string): Promise<{
    status: 'running' | 'complete'
    exploitsFound: number
    coverageEstimate: number
    refinedPolicyId: string | null
  }> {
    return this.get(`/policies/${policyId}/refine/status`)
  }

  // ── Escrow (§10.4) ───────────────────────────────────────────────────────

  async suggestCollateral(_counterpartyPubkey: string, _amountCents: number): Promise<CollateralSuggestion> {
    return { suggestedRatio: 0.5, confidence: 'low', dataPoints: 0 }
  }

  async proposeEscrow(params: {
    seller: string
    amountCents: number
    collateralRatio: number
    taskSpec: Record<string, unknown>
    policyId?: string
    verificationMethod?: VerificationMethod
    timeoutSeconds?: number
  }): Promise<Escrow> {
    return this.post('/escrow/propose', {
      seller: params.seller,
      amountCents: params.amountCents,
      sellerCollateral: Math.round(params.amountCents * params.collateralRatio),
      taskSpec: params.taskSpec,
      policyId: params.policyId,
      verificationMethod: params.verificationMethod ?? 'buyer_confirm',
      timeoutSeconds: params.timeoutSeconds ?? 3600,
    })
  }

  async getEscrow(escrowId: string): Promise<Escrow> {
    return this.get(`/escrow/${escrowId}`)
  }

  async acceptEscrow(escrowId: string): Promise<Escrow> {
    return this.post(`/escrow/${escrowId}/accept`, {})
  }

  async fundEscrow(_escrowId: string): Promise<Escrow> {
    throw new Error('Not implemented — in Stripe mode, use acceptEscrow() which handles funding atomically')
  }

  async deliver(escrowId: string, deliverable: Record<string, unknown>): Promise<VerificationResult> {
    return this.post(`/escrow/${escrowId}/deliver`, { deliverable })
  }

  async confirmDelivery(escrowId: string): Promise<Escrow> {
    const result = await this.post<Escrow>(`/escrow/${escrowId}/confirm`, {})
    // Auto-record success observation for seller
    this.observations.record(result.sellerId, {
      outcome: 'success',
      escrowId,
      verificationMethod: result.verificationMethod,
    })
    return result
  }

  async getVerification(escrowId: string): Promise<VerificationResult> {
    return this.get(`/verify/${escrowId}`)
  }

  // ── Disputes (§3.4) ──────────────────────────────────────────────────────

  async disputeEscrow(escrowId: string, reason: string): Promise<Escrow> {
    const result = await this.post<Escrow>(`/escrow/${escrowId}/dispute`, { reason })
    // Auto-record failure observation for counterparty
    // If we're the buyer, record against seller; if seller, against buyer
    const counterparty = result.buyerId === this.publicKey ? result.sellerId : result.buyerId
    this.observations.record(counterparty, {
      outcome: 'failure',
      escrowId,
    })
    return result
  }

  async fileForArbitration(params: {
    escrowId: string
    reason: string
    evidenceHash?: string
  }): Promise<Dispute> {
    return this.post('/disputes', params)
  }

  async getDispute(disputeId: string): Promise<Dispute> {
    return this.get(`/disputes/${disputeId}`)
  }

  async submitRuling(disputeId: string, params: {
    ruling: string
  }): Promise<Dispute> {
    return this.post(`/disputes/${disputeId}/ruling`, params)
  }

  // ── Attestations (§7) ────────────────────────────────────────────────────

  async publishAttestation(params: {
    subjectId: string
    escrowId?: string
    outcome: string
    verificationMethod?: string
  }): Promise<Attestation> {
    return this.post('/attestations', params)
  }

  // ── Observations (local — §7) ────────────────────────────────────────────

  recordObservation(counterpartyPubkey: string, observation: {
    outcome: 'success' | 'failure' | 'timeout'
    escrowId?: string
    verificationMethod?: string
    latencyMs?: number
  }): void {
    this.observations.record(counterpartyPubkey, observation)
  }
}
