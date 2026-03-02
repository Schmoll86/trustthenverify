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

import { publicKeyToAddress } from './channels.js'
export { signChannelPayment, verifyChannelPayment, publicKeyToAddress, encodeChannelClose } from './channels.js'
export type { ChannelPayment } from './channels.js'

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
  // Phase 7: Stripe Connect identity
  stripeCustomerId: string | null
  stripeConnectedAccountId: string | null
  stripeOnboardingComplete: boolean
  stripeDefaultPaymentMethod: string | null
  email: string | null
  notificationPreferences: Record<string, boolean> | null
  webhookUrl: string | null
  webhookSecret: string | null
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

export type FundingMode = 'stripe' | 'onchain' | 'x402'

export interface X402PaymentInstructions {
  gatewayAddress: string
  amountUsdc: string        // "5.50"
  amountUsdcRaw: string     // "5500000" (6 decimals)
  chainId: number           // 8453
  usdcContract: string
  escrowId: string
  nonce: string
  expiresAt: string
}

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
  // Phase 4: on-chain escrow fields
  fundingMode: FundingMode
  buyerAddress: string | null
  sellerAddress: string | null
  buyerFunded: boolean
  sellerFunded: boolean
  chainId: number | null
  txHash: string | null
  // Phase 6: Oracle fee surcharge
  oracleFeeCents: number
  // Phase 7: Stripe Connect per-escrow tracking
  stripeBuyerPiId: string | null
  stripeSellerCollateralPiId: string | null
  stripeTransferId: string | null
  buyerPaymentMethodId: string | null
  sellerPaymentMethodId: string | null
  // x402 payment fields
  x402TxHash: string | null
  x402Macaroon: string | null
  x402SettlementFeeCents: number
  x402SellerPayoutTx: string | null
}

export interface PaymentChannel {
  id: string
  buyerId: string
  sellerId: string
  buyerAddress: string
  sellerAddress: string
  channelAddress: string | null
  depositAmount: number
  spentAmount: number
  chainId: number
  status: string
  expiryAt: string
  createdAt: string
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
  ruling: 'buyer_wins' | 'seller_wins' | null
  status: 'pending' | 'resolved'
  createdAt: string
  resolvedAt: string | null
  /** Parsed from evidenceHash when ruling is via LLM arbitration */
  arbitrationDetails?: {
    rationale: string
    confidence: number
    fee: number
  }
}

// Phase 6: Oracle Consensus (§3.5)

export interface OraclePoolEntry {
  id: string
  agentId: string
  status: 'active' | 'withdrawn'
  capabilities: string[]
  tasksCompleted: number
  accuracyScore: number
  createdAt: string
  updatedAt: string
}

export interface OracleTask {
  id: string
  escrowId: string
  status: 'pending' | 'voting' | 'decided' | 'expired' | 'failed'
  quorum: number
  totalOracles: number
  consensus: 'pass' | 'fail' | 'no_consensus' | null
  deliverable: Record<string, unknown>
  taskSpec: string | null
  policyId: string | null
  votesPass: number
  votesFail: number
  expiresAt: string
  decidedAt: string | null
  createdAt: string
}

export interface OracleAssignment {
  id: string
  oracleTaskId: string
  oracleId: string
  agentId: string
  status: 'pending' | 'submitted' | 'expired'
  verdict: 'pass' | 'fail' | null
  rationale: string | null
  submittedAt: string | null
  createdAt: string
  oracleTask: OracleTask
}

export interface OracleVoteResult {
  voted: boolean
  verdict: 'pass' | 'fail'
  consensus: 'pass' | 'fail' | 'no_consensus' | null
  task: OracleTask
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

export async function listMarketplacePolicies(
  options?: { apiUrl?: string; search?: string; sort?: 'usage' | 'newest' }
): Promise<Policy[]> {
  const baseUrl = options?.apiUrl ?? DEFAULT_API_URL
  const qs = new URLSearchParams()
  if (options?.search) qs.set('search', options.search)
  if (options?.sort) qs.set('sort', options.sort)
  const query = qs.toString()
  const res = await fetch(`${baseUrl}/marketplace${query ? '?' + query : ''}`)
  if (!res.ok) throw new Error('Failed to fetch marketplace policies')
  return (await res.json() as { data: Policy[] }).data
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
    if (key) {
      // Sandbox key auth — simplified, no ECDSA
      headers = {
        'Content-Type': 'application/json',
        'X-Sandbox-Key': key,
        'X-Agent-Pubkey': params.publicKey,
      }
    } else {
      // No sandbox key — fall back to ECDSA signing against sandbox URL
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = await signRequest(params.privateKey, 'POST', path, body, timestamp)
      headers = {
        'Content-Type': 'application/json',
        'X-Agent-Pubkey': params.publicKey,
        'X-Agent-Timestamp': String(timestamp),
        'X-Agent-Signature': signature,
      }
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
  readonly publicKey: string
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
      if (key) {
        // Sandbox key auth — simplified, no ECDSA
        return {
          'X-Sandbox-Key': key,
          'X-Agent-Pubkey': this.publicKey,
          'Content-Type': 'application/json',
        }
      }
      // No sandbox key — fall back to ECDSA signing against sandbox URL
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

  async updateAgent(params: {
    name?: string
    endpoint?: string
    capabilities?: string[]
    metadata?: Record<string, unknown>
  }): Promise<Agent> {
    return this.post(`/agents/${this.publicKey}/update`, params)
  }

  async listPolicies(params?: {
    status?: string
    cursor?: string
  }): Promise<{ policies: Policy[]; cursor: string | null }> {
    const qs = new URLSearchParams()
    if (params?.status) qs.set('status', params.status)
    if (params?.cursor) qs.set('cursor', params.cursor)
    const query = qs.toString()
    return this.get(`/agents/${this.publicKey}/policies${query ? '?' + query : ''}`)
  }

  async getStats(): Promise<{
    totalEscrows: number
    asBuyer: number
    asSeller: number
    released: number
    failed: number
    disputed: number
    expired: number
    totalValueCents: number
    successRate: number | null
    uniqueCounterparties: number
  }> {
    return this.get(`/agents/${this.publicKey}/stats`)
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

  async useMarketplacePolicy(policyId: string): Promise<Policy> {
    return this.post(`/marketplace/${policyId}/use`, {})
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

  async suggestCollateral(counterpartyPubkey: string, _amountCents: number): Promise<CollateralSuggestion> {
    // 1. Local observations
    const localScore = this.observations.trustScore(counterpartyPubkey)
    const localCount = this.observations.getFor(counterpartyPubkey).length

    // 2. Remote attestations
    let remoteAttestations: Attestation[] = []
    try {
      remoteAttestations = await queryAttestations(counterpartyPubkey, {
        limit: 100,
        apiUrl: this.baseUrl,
      })
    } catch {
      // Network failure — use local data only
    }

    // 3. Compute remote score
    const remoteSuccesses = remoteAttestations.filter((a) => a.outcome === 'success').length
    const remoteTotal = remoteAttestations.length
    const remoteScore = remoteTotal > 0 ? remoteSuccesses / remoteTotal : null

    // 4. Blend scores (local weighted 2x — direct experience more trustworthy)
    const dataPoints = localCount + remoteTotal
    if (dataPoints === 0) {
      return { suggestedRatio: 0.5, confidence: 'low', dataPoints: 0 }
    }

    const localWeight = localScore !== null ? 2 : 0
    const remoteWeight = remoteScore !== null ? 1 : 0
    const totalWeight = localWeight + remoteWeight
    const blendedScore = totalWeight > 0
      ? ((localScore ?? 0) * localWeight + (remoteScore ?? 0) * remoteWeight) / totalWeight
      : 0.5

    // 5. Score -> collateral ratio (inverse — high trust = low collateral)
    const suggestedRatio = Math.max(0.1, Math.min(1.0, 1.0 - blendedScore * 0.8))

    // 6. Confidence from data volume
    const confidence: 'low' | 'medium' | 'high' =
      dataPoints >= 20 ? 'high' : dataPoints >= 5 ? 'medium' : 'low'

    return { suggestedRatio, confidence, dataPoints }
  }

  // ── Stripe Onboarding (§10.4a) ───────────────────────────────────────────

  async setupStripeCustomer(): Promise<Agent> {
    return this.post(`/agents/${this.publicKey}/stripe/customer`, {})
  }

  async setupStripeConnect(params?: {
    returnUrl?: string
    refreshUrl?: string
  }): Promise<{ agent: Agent; onboardingUrl: string }> {
    return this.post(`/agents/${this.publicKey}/stripe/connect`, params ?? {})
  }

  async getStripeStatus(): Promise<{
    hasCustomer: boolean
    hasConnectAccount: boolean
    onboardingComplete: boolean
    chargesEnabled: boolean
    payoutsEnabled: boolean
  }> {
    return this.get(`/agents/${this.publicKey}/stripe/status`)
  }

  async createSetupIntent(): Promise<{ setupIntentId: string; clientSecret: string }> {
    return this.post(`/agents/${this.publicKey}/stripe/setup-intent`, {})
  }

  async attachPaymentMethod(paymentMethodId: string): Promise<Agent> {
    return this.post(`/agents/${this.publicKey}/stripe/payment-method`, { paymentMethodId })
  }

  // ── Escrow (§10.4) ───────────────────────────────────────────────────────

  async proposeEscrow(params: {
    seller: string
    amountCents: number
    collateralRatio?: number
    taskSpec: Record<string, unknown>
    policyId?: string
    verificationMethod?: VerificationMethod
    timeoutSeconds?: number
    fundingMode?: FundingMode
    buyerAddress?: string
    sellerAddress?: string
    buyerPaymentMethodId?: string
  }): Promise<Escrow & { x402PaymentInstructions?: X402PaymentInstructions }> {
    return this.post('/escrow/propose', {
      seller: params.seller,
      amountCents: params.amountCents,
      sellerCollateral: Math.round(params.amountCents * (params.collateralRatio ?? 0.5)),
      taskSpec: params.taskSpec,
      policyId: params.policyId,
      verificationMethod: params.verificationMethod ?? 'buyer_confirm',
      timeoutSeconds: params.timeoutSeconds ?? 3600,
      fundingMode: params.fundingMode,
      buyerAddress: params.buyerAddress,
      sellerAddress: params.sellerAddress,
      buyerPaymentMethodId: params.buyerPaymentMethodId,
    })
  }

  async listEscrows(params?: {
    status?: string
    role?: 'buyer' | 'seller'
    cursor?: string
  }): Promise<{ escrows: Escrow[]; cursor: string | null }> {
    const qs = new URLSearchParams()
    if (params?.status) qs.set('status', params.status)
    if (params?.role) qs.set('role', params.role)
    if (params?.cursor) qs.set('cursor', params.cursor)
    const query = qs.toString()
    return this.get(`/agents/${this.publicKey}/escrows${query ? '?' + query : ''}`)
  }

  async getEscrow(escrowId: string): Promise<Escrow> {
    return this.get(`/escrow/${escrowId}`)
  }

  async acceptEscrow(escrowId: string): Promise<Escrow> {
    return this.post(`/escrow/${escrowId}/accept`, {})
  }

  /** Notify API that on-chain funding has been submitted. On-chain escrows only. */
  async fundEscrow(escrowId: string): Promise<Escrow> {
    return this.post(`/escrow/${escrowId}/fund`, {})
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

  // ── Oracle Pool (§3.5) ──────────────────────────────────────────────────

  async joinOraclePool(params?: { capabilities?: string[] }): Promise<OraclePoolEntry> {
    return this.post('/oracles/join', params ?? {})
  }

  async withdrawFromOraclePool(): Promise<OraclePoolEntry> {
    return this.post('/oracles/withdraw', {})
  }

  async getOracleStatus(): Promise<OraclePoolEntry> {
    return this.get('/oracles/status')
  }

  async getOracleAssignments(): Promise<OracleAssignment[]> {
    return this.get('/oracles/tasks')
  }

  async submitOracleVote(params: {
    oracleTaskId: string
    verdict: 'pass' | 'fail'
    rationale?: string
  }): Promise<OracleVoteResult> {
    return this.post('/oracles/vote', params)
  }

  async getOracleTask(taskId: string): Promise<OracleTask> {
    return this.get(`/oracles/task/${taskId}`)
  }

  async getOracleEarnings(): Promise<{
    totalCents: number
    pendingCents: number
    paidCents: number
    paymentCount: number
  }> {
    return this.get('/oracles/earnings')
  }

  // ── Payment Channels (§8) ──────────────────────────────────────────────

  async registerChannel(params: {
    channelAddress: string
    counterparty: string
    depositAmount: number
    chainId: number
    expiryAt: string
    buyerAddress?: string
    sellerAddress?: string
  }): Promise<PaymentChannel> {
    return this.post('/channels', params)
  }

  async getChannel(channelAddress: string): Promise<PaymentChannel> {
    return this.get(`/channels/${channelAddress}`)
  }

  async closeChannel(channelAddress: string): Promise<PaymentChannel> {
    return this.post(`/channels/${channelAddress}/close`, {})
  }

  // ── x402 Payment (§10.5) ──────────────────────────────────────────────────

  /** Pay for an x402 escrow with a USDC transaction hash. Returns escrow with macaroon. */
  async x402Pay(escrowId: string, txHash: string): Promise<Escrow & { x402Macaroon: string }> {
    return this.post(`/escrow/${escrowId}/x402-pay`, { txHash })
  }

  /** Get your Ethereum address (derived from agent key). */
  getEthAddress(): string {
    return publicKeyToAddress(this.publicKey)
  }

  /** Check USDC balance on Base. No auth required. */
  async checkUsdcBalance(address?: string): Promise<{ address: string; balance: string; balanceRaw: string }> {
    const addr = address ?? this.getEthAddress()
    const res = await fetch(`${this.baseUrl}/x402/balance/${addr}`)
    const json = await res.json() as { data: { address: string; balance: string; balanceRaw: string }; error?: { message: string } }
    if (!res.ok) throw new Error(json.error?.message ?? `Request failed: ${res.status}`)
    return json.data
  }

  /** Register webhook URL for instant notifications. */
  async registerWebhook(url: string): Promise<{ webhookUrl: string; webhookSecret: string }> {
    return this.post(`/agents/${this.publicKey}/webhook`, { url })
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
