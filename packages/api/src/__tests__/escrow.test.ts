import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockStripe } from './helpers/mock-stripe'

let mockDb: MockDb
const mockStripe = createMockStripe()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

// Inject mock stripe into the escrow route module
vi.mock('../lib/stripe', () => ({
  RealStripeService: class {
    captureEscrowFunds = mockStripe.captureEscrowFunds
    releaseFunds = mockStripe.releaseFunds
    burnFunds = mockStripe.burnFunds
    refundBuyerAndBurnCollateral = mockStripe.refundBuyerAndBurnCollateral
  },
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'test-gateway-key',
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_mock',
}

async function makeSignedRequest(
  method: string,
  path: string,
  body: string,
  keypair: { publicKey: string; privateKey: string },
) {
  const timestamp = Math.floor(Date.now() / 1000)
  const sigPath = path.replace('/v2', '')
  const signature = await signRequest(keypair.privateKey, method, sigPath, body, timestamp)
  return app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Pubkey': keypair.publicKey,
      'X-Agent-Timestamp': String(timestamp),
      'X-Agent-Signature': signature,
    },
    body: method === 'GET' ? undefined : body,
  }, env)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedAgents(buyer: { publicKey: string }, seller: { publicKey: string }) {
  mockDb.seedTable('agents', [
    {
      id: 'buyer-id',
      public_key: buyer.publicKey,
      endpoint: null,
      name: 'buyer',
      capabilities: [],
      metadata: {},
      parent_id: null,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    },
    {
      id: 'seller-id',
      public_key: seller.publicKey,
      endpoint: null,
      name: 'seller',
      capabilities: ['web-search'],
      metadata: {},
      parent_id: null,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    },
  ])
}

function seedEscrow(overrides: Record<string, unknown> = {}) {
  const escrow = {
    id: 'escrow-1',
    contract_address: null,
    stripe_escrow_id: null,
    buyer_id: 'buyer-id',
    seller_id: 'seller-id',
    amount_cents: 5000,
    seller_collateral: 2500,
    task_hash: 'abc123',
    task_spec: { type: 'web-search', query: 'test' },
    policy_id: null,
    verification_method: 'buyer_confirm',
    dispute_resolution: 'burn',
    status: 'proposed',
    proof: null,
    timeout_seconds: 3600,
    created_at: new Date().toISOString(),
    funded_at: null,
    completed_at: null,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    ...overrides,
  }
  mockDb.seedTable('escrows', [escrow])
  return escrow
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /v2/escrow/:id', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('returns escrow by ID', async () => {
    const buyer = generateKeypair()
    const seller = generateKeypair()
    seedAgents(buyer, seller)
    seedEscrow()

    const res = await app.request('/v2/escrow/escrow-1', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { id: string; amountCents: number } }
    expect(json.data.id).toBe('escrow-1')
    expect(json.data.amountCents).toBe(5000)
  })

  it('returns 404 for missing escrow', async () => {
    const res = await app.request('/v2/escrow/nonexistent', { method: 'GET' }, env)
    expect(res.status).toBe(404)
  })
})

describe('POST /v2/escrow/propose', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
    // Ensure escrows and verifications tables exist
    mockDb.seedTable('escrows', [])
    mockDb.seedTable('verifications', [])
    mockDb.seedTable('disputes', [])
  })

  it('creates escrow with valid params → 201', async () => {
    const body = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 5000,
      sellerCollateral: 2500,
      taskSpec: { type: 'web-search', query: 'test' },
      verificationMethod: 'buyer_confirm',
      timeoutSeconds: 3600,
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/propose', body, buyer)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: { status: string; amountCents: number; buyerId: string } }
    expect(json.data.status).toBe('proposed')
    expect(json.data.amountCents).toBe(5000)
    expect(json.data.buyerId).toBe('buyer-id')
  })

  it('rejects when seller not found', async () => {
    const body = JSON.stringify({
      seller: 'nonexistent-pubkey',
      amountCents: 5000,
      sellerCollateral: 2500,
      taskSpec: { type: 'test' },
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/propose', body, buyer)
    expect(res.status).toBe(404)
  })

  it('rejects buyer == seller', async () => {
    // Buyer tries to escrow with self
    const body = JSON.stringify({
      seller: buyer.publicKey,
      amountCents: 5000,
      sellerCollateral: 2500,
      taskSpec: { type: 'test' },
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/propose', body, buyer)
    expect(res.status).toBe(400)
  })

  it('rejects amountCents <= 0', async () => {
    const body = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 0,
      sellerCollateral: 0,
      taskSpec: { type: 'test' },
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/propose', body, buyer)
    expect(res.status).toBe(400)
  })
})

describe('POST /v2/escrow/:id/accept', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
  })

  it('seller accepts proposed escrow → active', async () => {
    seedEscrow()

    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/accept', '{}', seller)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string; stripeEscrowId: string } }
    expect(json.data.status).toBe('active')
    expect(json.data.stripeEscrowId).toBe('pi_mock_1')
    expect(mockStripe.calls).toHaveLength(1)
    expect(mockStripe.calls[0].method).toBe('captureEscrowFunds')
  })

  it('rejects non-seller', async () => {
    seedEscrow()
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/accept', '{}', buyer)
    expect(res.status).toBe(403)
  })

  it('rejects if not proposed', async () => {
    seedEscrow({ status: 'active' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/accept', '{}', seller)
    expect(res.status).toBe(409)
  })

  it('rejects expired proposal', async () => {
    seedEscrow({ expires_at: new Date(Date.now() - 1000).toISOString() })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/accept', '{}', seller)
    expect(res.status).toBe(409)
  })
})

describe('POST /v2/escrow/:id/deliver', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
  })

  it('seller delivers → delivered with proof hash', async () => {
    seedEscrow({ status: 'active', stripe_escrow_id: 'pi_mock_1' })

    const deliverable = { results: ['result1', 'result2'] }
    const body = JSON.stringify({ deliverable })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/deliver', body, seller)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string; proof: string } }
    expect(json.data.status).toBe('delivered')
    expect(json.data.proof).toBeTruthy()
  })

  it('rejects non-seller', async () => {
    seedEscrow({ status: 'active' })

    const body = JSON.stringify({ deliverable: { data: 'test' } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/deliver', body, buyer)
    expect(res.status).toBe(403)
  })

  it('rejects if not active', async () => {
    seedEscrow({ status: 'proposed' })

    const body = JSON.stringify({ deliverable: { data: 'test' } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/deliver', body, seller)
    expect(res.status).toBe(409)
  })

  it('rejects if expired', async () => {
    seedEscrow({ status: 'active', expires_at: new Date(Date.now() - 1000).toISOString() })

    const body = JSON.stringify({ deliverable: { data: 'test' } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/deliver', body, seller)
    expect(res.status).toBe(409)
  })
})

describe('POST /v2/escrow/:id/confirm', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
    mockDb.seedTable('verifications', [])
  })

  it('buyer confirms → released + funds released', async () => {
    seedEscrow({ status: 'delivered', stripe_escrow_id: 'pi_mock_1', proof: 'abc123' })

    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/confirm', '{}', buyer)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string; completedAt: string } }
    expect(json.data.status).toBe('released')
    expect(json.data.completedAt).toBeTruthy()
    expect(mockStripe.calls).toHaveLength(1)
    expect(mockStripe.calls[0].method).toBe('releaseFunds')

    // Verification record should be inserted
    const verifications = mockDb.getTable('verifications').rows
    expect(verifications).toHaveLength(1)
    expect(verifications[0].result).toBe('pass')
    expect(verifications[0].method).toBe('buyer_confirm')
  })

  it('rejects non-buyer', async () => {
    seedEscrow({ status: 'delivered' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/confirm', '{}', seller)
    expect(res.status).toBe(403)
  })

  it('rejects if not delivered', async () => {
    seedEscrow({ status: 'active' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/confirm', '{}', buyer)
    expect(res.status).toBe(409)
  })
})

describe('POST /v2/escrow/:id/dispute', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
    mockDb.seedTable('disputes', [])
  })

  it('buyer disputes active escrow → burned', async () => {
    seedEscrow({ status: 'active', stripe_escrow_id: 'pi_mock_1' })

    const body = JSON.stringify({ reason: 'seller unresponsive' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/dispute', body, buyer)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('burned')
    expect(mockStripe.calls).toHaveLength(1)
    expect(mockStripe.calls[0].method).toBe('burnFunds')

    // Dispute record
    const disputes = mockDb.getTable('disputes').rows
    expect(disputes).toHaveLength(1)
    expect(disputes[0].reason).toBe('seller unresponsive')
  })

  it('seller disputes delivered escrow → burned', async () => {
    seedEscrow({ status: 'delivered', stripe_escrow_id: 'pi_mock_1' })

    const body = JSON.stringify({ reason: 'buyer unreasonable' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/dispute', body, seller)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('burned')
  })

  it('rejects third party', async () => {
    seedEscrow({ status: 'active' })

    const thirdParty = generateKeypair()
    // Register third party
    mockDb.getTable('agents').rows.push({
      id: 'third-id',
      public_key: thirdParty.publicKey,
      endpoint: null,
      name: 'third',
      capabilities: [],
      metadata: {},
      parent_id: null,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    })

    const body = JSON.stringify({ reason: 'not my business' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/dispute', body, thirdParty)
    expect(res.status).toBe(403)
  })

  it('rejects dispute on proposed escrow', async () => {
    seedEscrow({ status: 'proposed' })

    const body = JSON.stringify({ reason: 'too early' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/dispute', body, buyer)
    expect(res.status).toBe(409)
  })

  it('rejects dispute on already released escrow', async () => {
    seedEscrow({ status: 'released' })

    const body = JSON.stringify({ reason: 'too late' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/dispute', body, buyer)
    expect(res.status).toBe(409)
  })
})

describe('Full happy path: propose → accept → deliver → confirm', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
    mockDb.seedTable('escrows', [])
    mockDb.seedTable('verifications', [])
    mockDb.seedTable('disputes', [])
  })

  it('completes full escrow lifecycle', async () => {
    // 1. Propose
    const proposeBody = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 10000,
      sellerCollateral: 5000,
      taskSpec: { type: 'translation', text: 'Hello world', targetLang: 'es' },
      verificationMethod: 'buyer_confirm',
      timeoutSeconds: 3600,
    })

    const proposeRes = await makeSignedRequest('POST', '/v2/escrow/propose', proposeBody, buyer)
    expect(proposeRes.status).toBe(201)
    const proposed = (await proposeRes.json() as { data: { id: string; status: string } }).data
    expect(proposed.status).toBe('proposed')
    const escrowId = proposed.id

    // 2. Accept (seller)
    const acceptRes = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/accept`, '{}', seller)
    expect(acceptRes.status).toBe(200)
    const accepted = (await acceptRes.json() as { data: { status: string; fundedAt: string } }).data
    expect(accepted.status).toBe('active')
    expect(accepted.fundedAt).toBeTruthy()

    // 3. Deliver (seller)
    const deliverBody = JSON.stringify({
      deliverable: { translation: 'Hola mundo', confidence: 0.98 },
    })
    const deliverRes = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/deliver`, deliverBody, seller)
    expect(deliverRes.status).toBe(200)
    const delivered = (await deliverRes.json() as { data: { status: string; proof: string } }).data
    expect(delivered.status).toBe('delivered')
    expect(delivered.proof).toBeTruthy()

    // 4. Confirm (buyer)
    const confirmRes = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/confirm`, '{}', buyer)
    expect(confirmRes.status).toBe(200)
    const released = (await confirmRes.json() as { data: { status: string; completedAt: string } }).data
    expect(released.status).toBe('released')
    expect(released.completedAt).toBeTruthy()

    // Verify Stripe calls
    expect(mockStripe.calls).toHaveLength(2)
    expect(mockStripe.calls[0].method).toBe('captureEscrowFunds')
    expect(mockStripe.calls[1].method).toBe('releaseFunds')

    // Verify verification record
    const verifications = mockDb.getTable('verifications').rows
    expect(verifications).toHaveLength(1)
    expect(verifications[0].result).toBe('pass')
  })
})
