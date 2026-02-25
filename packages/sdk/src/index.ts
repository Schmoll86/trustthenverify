const DEFAULT_API_URL = 'https://api.trustthenverify.com/v1'

// ── Zero-config reads (no account needed) ─────────────────────────────────────

export async function isTrusted(agentId: string, apiUrl = DEFAULT_API_URL): Promise<boolean> {
  const res = await fetch(`${apiUrl}/trust/${agentId}`)
  const data = await res.json() as { data: { score: number } }
  return data.data.score >= 20
}

export async function lookup(agentId: string, apiUrl = DEFAULT_API_URL): Promise<TrustScore> {
  const res = await fetch(`${apiUrl}/trust/${agentId}`)
  const data = await res.json() as { data: TrustScore }
  return data.data
}

// ── Agent client (requires credentials) ──────────────────────────────────────

export class TrustClient {
  private apiUrl: string
  private agentId?: string
  private secret?: string

  constructor(opts: { agentId?: string; secret?: string; apiUrl?: string } = {}) {
    this.apiUrl = opts.apiUrl ?? DEFAULT_API_URL
    this.agentId = opts.agentId
    this.secret = opts.secret
  }

  /** Register a new agent. Returns credentials — store privateKey securely, never sent again. */
  async register(name: string, contact: string, opts: RegisterOptions = {}): Promise<AgentCredentials> {
    const res = await fetch(`${this.apiUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, contact, ...opts })
    })
    const data = await res.json() as { data: AgentCredentials }
    this.agentId = data.data.agentId
    this.secret = data.data.secret
    return data.data
  }

  /** Run all autonomous trust challenges. Zero human steps. Reaches Orange tier (~43pts) in ~5 min. */
  async runTrustChallenges(opts: ChallengeOptions = {}): Promise<ChallengeResults> {
    // TODO: implement challenge orchestration (Section 4.9)
    throw new Error('Not implemented yet')
  }

  /** Check whether an agent is safe to transact with at a given amount. */
  async checkBeforeTransaction(counterpartyId: string, amountCents: number): Promise<TransactionCheck> {
    const score = await lookup(counterpartyId, this.apiUrl)
    const required = amountCents < 100 ? 20
      : amountCents < 1000 ? 40
      : amountCents < 10000 ? 60
      : 75
    return {
      proceed: score.total >= required,
      score: score.total,
      tier: score.tier,
      requiredScore: required
    }
  }

  /** Submit a verified review. Receipt is required — no receipt, no review. */
  async review(agentId: string, rating: 1|2|3|4|5, comment: string, opts: ReviewOptions): Promise<void> {
    // TODO: implement (Section 7)
    throw new Error('Not implemented yet')
  }

  /** Request a trust-scored Lightning invoice for paying another agent (Section 5.3). */
  async paymentRequest(payeeAgentId: string, amountSats: number, contextId: string): Promise<PaymentRequest> {
    // TODO: implement NWC invoice creation
    throw new Error('Not implemented yet')
  }

  /** Poll Lightning payment settlement status. */
  async paymentStatus(paymentId: string): Promise<PaymentStatus> {
    // TODO: implement
    throw new Error('Not implemented yet')
  }

  private authHeaders(): Record<string, string> {
    if (!this.secret) throw new Error('TrustClient: no secret set — call register() first or pass credentials to constructor')
    return { 'X-Agent-Secret': this.secret }
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrustScore {
  agentId: string
  total: number
  tier: 'Unverified' | 'New / Limited' | 'Moderate' | 'Trusted' | 'Highly Trusted'
  dimensions: { identity: number; economic: number; social: number; behavioral: number }
  lastUpdated: string
}

export interface AgentCredentials {
  agentId: string
  secret: string
  publicKey?: string
  privateKey?: string   // returned once only — store securely
}

export interface RegisterOptions {
  generateKeypair?: boolean
  endpoint?: string
  capabilities?: string[]
}

export interface ChallengeOptions {
  categories?: ('crypto' | 'behavioral' | 'adversarial' | 'transaction')[]
  concurrency?: number
}

export interface ChallengeResults {
  passed: number
  failed: number
  pointsEarned: number
  newScore: number
  failedDetails: { challengeType: string; reason: string }[]
}

export interface TransactionCheck {
  proceed: boolean
  score: number
  tier: string
  requiredScore: number
}

export interface ReviewOptions {
  receipt: { type: 'stripe' | 'lightning' | 'eth' | 'solana'; id: string }
}

export interface PaymentRequest {
  bolt11: string
  paymentId: string
  expiresAt: string
}

export interface PaymentStatus {
  settled: boolean
  preimageVerified: boolean
  transactionId?: string
}
