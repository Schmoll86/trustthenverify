import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockStripe } from './helpers/mock-stripe'
import { createMockGateway } from './helpers/mock-gateway'

let mockDb: MockDb
const mockStripe = createMockStripe()
const mockGateway = createMockGateway()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

vi.mock('../lib/stripe', () => ({
  RealStripeService: class {
    captureEscrowFunds = mockStripe.captureEscrowFunds
    releaseFunds = mockStripe.releaseFunds
    burnFunds = mockStripe.burnFunds
    refundBuyerAndBurnCollateral = mockStripe.refundBuyerAndBurnCollateral
  },
}))

vi.mock('../lib/gateway', () => ({
  RealGatewayService: class {
    verify = mockGateway.verify
  },
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'a'.repeat(64),
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
    stripe_escrow_id: 'pi_mock_1',
    buyer_id: 'buyer-id',
    seller_id: 'seller-id',
    amount_cents: 5000,
    seller_collateral: 2500,
    task_hash: 'abc123',
    task_spec: { type: 'web-search', query: 'test' },
    policy_id: 'policy-1',
    verification_method: 'automated_reasoning',
    dispute_resolution: 'burn',
    status: 'active',
    proof: null,
    timeout_seconds: 3600,
    delivery_attempts: 0,
    created_at: new Date().toISOString(),
    funded_at: new Date().toISOString(),
    completed_at: null,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    ...overrides,
  }
  mockDb.seedTable('escrows', [escrow])
  return escrow
}

describe('Automated verification: automated_reasoning', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    mockGateway.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
    mockDb.seedTable('verifications', [])
  })

  it('pass → auto-release funds', async () => {
    seedEscrow()
    mockGateway.setResult({
      result: 'pass',
      constraintsTotal: 3,
      constraintsPassed: 3,
      failures: [],
      gatewaySignature: 'sig_mock',
      verifiedAt: new Date().toISOString(),
    })

    const body = JSON.stringify({ deliverable: { results: [{ url: 'https://a.com' }] } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/deliver', body, seller)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string; completedAt: string } }
    expect(json.data.status).toBe('released')
    expect(json.data.completedAt).toBeTruthy()

    // Stripe release called
    expect(mockStripe.calls.some(c => c.method === 'releaseFunds')).toBe(true)

    // Verification record stored
    const verifications = mockDb.getTable('verifications').rows
    expect(verifications).toHaveLength(1)
    expect(verifications[0].result).toBe('pass')
    expect(verifications[0].method).toBe('automated_reasoning')
    expect(verifications[0].gateway_signature).toBe('sig_mock')
  })

  it('fail → auto-fail + refund buyer', async () => {
    seedEscrow()
    mockGateway.setResult({
      result: 'fail',
      constraintsTotal: 3,
      constraintsPassed: 1,
      failures: [{ id: 'c2', error: 'count too low' }],
      gatewaySignature: 'sig_fail',
      verifiedAt: new Date().toISOString(),
    })

    const body = JSON.stringify({ deliverable: { results: [] } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/deliver', body, seller)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('failed')

    // Refund buyer called
    expect(mockStripe.calls.some(c => c.method === 'refundBuyerAndBurnCollateral')).toBe(true)
    const refundCall = mockStripe.calls.find(c => c.method === 'refundBuyerAndBurnCollateral')
    expect(refundCall?.params.buyerRefundCents).toBe(5000)

    // Verification record
    const verifications = mockDb.getTable('verifications').rows
    expect(verifications).toHaveLength(1)
    expect(verifications[0].result).toBe('fail')
  })

  it('error → stays delivered, returns 422', async () => {
    seedEscrow()
    mockGateway.setResult({
      result: 'error',
      constraintsTotal: 0,
      constraintsPassed: 0,
      failures: [{ id: '_gateway', error: 'solver crash' }],
      gatewaySignature: '',
      verifiedAt: new Date().toISOString(),
    })

    const body = JSON.stringify({ deliverable: { bad: true } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/deliver', body, seller)
    expect(res.status).toBe(422)

    // Escrow stays delivered
    const escrow = mockDb.getTable('escrows').rows[0]
    expect(escrow.status).toBe('delivered')
    expect(escrow.delivery_attempts).toBe(1)
  })

  it('3 errors → fallback to buyer_confirm', async () => {
    seedEscrow({ delivery_attempts: 2 })
    mockGateway.setResult({
      result: 'error',
      constraintsTotal: 0,
      constraintsPassed: 0,
      failures: [{ id: '_gateway', error: 'crash' }],
      gatewaySignature: '',
      verifiedAt: new Date().toISOString(),
    })

    const body = JSON.stringify({ deliverable: { bad: true } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/deliver', body, seller)
    expect(res.status).toBe(422)

    const escrow = mockDb.getTable('escrows').rows[0]
    expect(escrow.verification_method).toBe('buyer_confirm')
  })
})

describe('Automated verification: schema_validation', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    mockGateway.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
    mockDb.seedTable('verifications', [])
  })

  it('schema pass → auto-release', async () => {
    seedEscrow({
      verification_method: 'schema_validation',
      policy_id: null,
      task_spec: {
        type: 'translation',
        expected_schema: { type: 'object', required: ['text'] },
      },
    })
    mockGateway.setResult({
      result: 'pass',
      constraintsTotal: 1,
      constraintsPassed: 1,
      failures: [],
      gatewaySignature: 'sig_schema',
      verifiedAt: new Date().toISOString(),
    })

    const body = JSON.stringify({ deliverable: { text: 'Hola mundo' } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/deliver', body, seller)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('released')
  })

  it('schema fail → auto-fail', async () => {
    seedEscrow({
      verification_method: 'schema_validation',
      policy_id: null,
      task_spec: {
        type: 'translation',
        expected_schema: { type: 'object', required: ['text'] },
      },
    })
    mockGateway.setResult({
      result: 'fail',
      constraintsTotal: 1,
      constraintsPassed: 0,
      failures: [{ id: '_schema', error: 'missing field' }],
      gatewaySignature: 'sig_fail',
      verifiedAt: new Date().toISOString(),
    })

    const body = JSON.stringify({ deliverable: { wrong: 'field' } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/deliver', body, seller)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('failed')
  })
})

describe('buyer_confirm still works after Phase 2', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    mockGateway.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
    mockDb.seedTable('verifications', [])
  })

  it('buyer_confirm deliver does not trigger gateway', async () => {
    seedEscrow({ verification_method: 'buyer_confirm', policy_id: null })

    const body = JSON.stringify({ deliverable: { data: 'test' } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-1/deliver', body, seller)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('delivered')

    // Gateway NOT called
    expect(mockGateway.calls).toHaveLength(0)
  })
})

describe('GET /v2/verify/:escrow_id', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('returns latest verification for escrow', async () => {
    mockDb.seedTable('verifications', [
      {
        id: 'ver-1',
        escrow_id: 'escrow-1',
        method: 'automated_reasoning',
        policy_id: 'policy-1',
        result: 'pass',
        constraints_total: 3,
        constraints_passed: 3,
        failure_details: null,
        proof_hash: 'abc',
        gateway_signature: 'sig123',
        verified_at: new Date().toISOString(),
      },
    ])

    const res = await app.request('/v2/verify/escrow-1', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { result: string; constraintsTotal: number; gatewaySignature: string } }
    expect(json.data.result).toBe('pass')
    expect(json.data.constraintsTotal).toBe(3)
    expect(json.data.gatewaySignature).toBe('sig123')
  })

  it('returns 404 for no verification', async () => {
    mockDb.seedTable('verifications', [])
    const res = await app.request('/v2/verify/nonexistent', { method: 'GET' }, env)
    expect(res.status).toBe(404)
  })
})

describe('Full automated flow: propose → accept → deliver (automated_reasoning) → auto-release', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    mockGateway.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
    mockDb.seedTable('escrows', [])
    mockDb.seedTable('verifications', [])
    mockDb.seedTable('disputes', [])
  })

  it('completes full automated escrow lifecycle', async () => {
    // 1. Propose with automated_reasoning
    const proposeBody = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 10000,
      sellerCollateral: 5000,
      taskSpec: { type: 'web-search', query: 'test' },
      policyId: 'policy-1',
      verificationMethod: 'automated_reasoning',
      timeoutSeconds: 3600,
    })

    const proposeRes = await makeSignedRequest('POST', '/v2/escrow/propose', proposeBody, buyer)
    expect(proposeRes.status).toBe(201)
    const proposed = (await proposeRes.json() as { data: { id: string; status: string } }).data
    expect(proposed.status).toBe('proposed')
    const escrowId = proposed.id

    // 2. Accept
    const acceptRes = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/accept`, '{}', seller)
    expect(acceptRes.status).toBe(200)
    const accepted = (await acceptRes.json() as { data: { status: string } }).data
    expect(accepted.status).toBe('active')

    // 3. Deliver → auto-verify → auto-release
    mockGateway.setResult({
      result: 'pass',
      constraintsTotal: 3,
      constraintsPassed: 3,
      failures: [],
      gatewaySignature: 'sig_full_flow',
      verifiedAt: new Date().toISOString(),
    })

    const deliverBody = JSON.stringify({
      deliverable: { results: [{ url: 'https://a.com' }, { url: 'https://b.com' }, { url: 'https://c.com' }] },
    })
    const deliverRes = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/deliver`, deliverBody, seller)
    expect(deliverRes.status).toBe(200)
    const released = (await deliverRes.json() as { data: { status: string; completedAt: string } }).data
    expect(released.status).toBe('released')
    expect(released.completedAt).toBeTruthy()

    // Stripe: captureEscrowFunds + releaseFunds
    expect(mockStripe.calls).toHaveLength(2)
    expect(mockStripe.calls[0].method).toBe('captureEscrowFunds')
    expect(mockStripe.calls[1].method).toBe('releaseFunds')

    // Verification record
    const verifications = mockDb.getTable('verifications').rows
    expect(verifications).toHaveLength(1)
    expect(verifications[0].result).toBe('pass')
    expect(verifications[0].gateway_signature).toBe('sig_full_flow')
  })
})
