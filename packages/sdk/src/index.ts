// BillyV2 SDK — @billyv2/sdk
// Replaces @trustthenverify/sdk
//
// Zero-config reads require no account.
// Writes require an agentId + secret (from registration).

const DEFAULT_API_URL = 'https://api.trustthenverify.com/v1'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrustScore {
  agentId: string
  total: number
  tier: 'unverified' | 'limited' | 'moderate' | 'trusted' | 'highly_trusted'
  dimensions: {
    identity: number
    economic: number
    social: number
    behavioral: number
  }
  bootstrapped: boolean   // true if score includes operator_inherited points
  lastUpdated: string
}

export interface AgentCredentials {
  agentId: string
  secret: string
  publicKey: string | null
  privateKey: string | null   // returned once at registration — store immediately
  initialScore: number
  nextSteps: Array<{ action: string; description: string; points: number }>
}

export interface ChallengeResults {
  passed: number
  failed: number
  pointsEarned: number
  newScore: number
  results: Array<{
    challengeType: string
    passed: boolean
    pointsAwarded: number
    registrySig: string
  }>
}

// ─── Zero-config reads ────────────────────────────────────────────────────────

export async function isTrusted(
  agentId: string,
  options?: { apiUrl?: string }
): Promise<boolean> {
  const score = await lookup(agentId, options)
  return score.total >= 20
}

export async function lookup(
  agentId: string,
  options?: { apiUrl?: string }
): Promise<TrustScore> {
  const baseUrl = options?.apiUrl ?? DEFAULT_API_URL
  const res = await fetch(`${baseUrl}/trust/${agentId}`)
  if (!res.ok) throw new Error(`Agent not found: ${agentId}`)
  const json = await res.json() as { success: boolean; data: TrustScore }
  return json.data
}

// ─── TrustClient (authenticated) ─────────────────────────────────────────────

export interface TrustClientOptions {
  agentId: string
  secret: string
  privateKey?: string      // required for Level 2+ signed requests
  apiUrl?: string
}

export class TrustClient {
  private agentId: string
  private secret: string
  private privateKey?: string
  private baseUrl: string

  constructor(options: TrustClientOptions) {
    this.agentId = options.agentId
    this.secret = options.secret
    this.privateKey = options.privateKey
    this.baseUrl = options.apiUrl ?? DEFAULT_API_URL
  }

  private authHeaders(): Record<string, string> {
    // TODO: if privateKey present, use X-Agent-Signature (Level 2+)
    // For now: X-Agent-Secret (Level 0-1)
    return { 'X-Agent-Secret': this.secret, 'Content-Type': 'application/json' }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    })
    const json = await res.json() as { success: boolean; data: T; error?: string }
    if (!json.success) throw new Error(json.error ?? 'Request failed')
    return json.data
  }

  /** Pre-transaction safety check. Throws if agent score is insufficient for amount. */
  async checkBeforeTransaction(counterpartyId: string, amountCents: number): Promise<TrustScore> {
    const score = await lookup(counterpartyId, { apiUrl: this.baseUrl })
    const required =
      amountCents < 100 ? 20 :
      amountCents < 1000 ? 40 :
      amountCents < 10000 ? 60 : 75

    if (score.total < required) {
      throw new Error(
        `Agent ${counterpartyId} has score ${score.total} (${score.tier}). ` +
        `Transaction of $${(amountCents / 100).toFixed(2)} requires score ≥ ${required}.`
      )
    }
    return score
  }

  /** Run all autonomous trust challenges. Returns Orange tier in ~5 minutes with zero human steps. */
  async runTrustChallenges(options?: {
    categories?: ('crypto' | 'behavioral' | 'adversarial' | 'transaction')[]
    concurrency?: number
  }): Promise<ChallengeResults> {
    // 1. Request challenge set from registry
    const { challengeSetId, challenges } = await this.post<{ challengeSetId: string; challenges: unknown[] }>(
      '/challenge/batch',
      { agentId: this.agentId, categories: options?.categories }
    )
    // TODO: solve challenges (sign nonces, call own endpoint for behavioral, evaluate adversarial)
    // 2. Submit results
    return this.post<ChallengeResults>('/challenge/submit', {
      agentId: this.agentId,
      challengeSetId,
      results: [],   // TODO: populated after solving
    })
  }

  /** Submit a verified review. Receipt is required — no receipt, no review. */
  async review(
    agentId: string,
    rating: 1 | 2 | 3 | 4 | 5,
    comment: string,
    receipt: { type: 'stripe' | 'lightning' | 'eth' | 'solana'; id: string }
  ): Promise<{ reviewId: string; pointsAwarded: number }> {
    return this.post('/reviews', { agentId, rating, comment, receipt })
  }

  /** Request a trust-scored Lightning invoice for paying another agent. */
  async paymentRequest(
    payeeAgentId: string,
    amountSats: number,
    contextId?: string
  ): Promise<{ paymentId: string; bolt11: string; expiresAt: string }> {
    return this.post('/payment/request', { payeeAgentId, amountSats, contextId })
  }

  /** Check Lightning payment settlement status. */
  async paymentStatus(paymentId: string): Promise<{
    settled: boolean
    preimageVerified: boolean
    transactionId: string | null
  }> {
    const res = await fetch(`${this.baseUrl}/payment/${paymentId}`, { headers: this.authHeaders() })
    const json = await res.json() as { success: boolean; data: unknown }
    return json.data as { settled: boolean; preimageVerified: boolean; transactionId: string | null }
  }
}

// ─── Static registration (no existing client required) ───────────────────────

export async function register(
  name: string,
  contact: string,
  options?: {
    generateKeypair?: boolean
    endpoint?: string
    operatorId?: string
    operatorSecret?: string
    apiUrl?: string
  }
): Promise<AgentCredentials> {
  const baseUrl = options?.apiUrl ?? DEFAULT_API_URL
  const res = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, contact, ...options }),
  })
  const json = await res.json() as { success: boolean; data: AgentCredentials }
  if (!json.success) throw new Error('Registration failed')
  return json.data
}
