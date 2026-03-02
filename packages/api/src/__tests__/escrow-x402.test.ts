import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockStripe } from './helpers/mock-stripe'
import { createMockX402 } from './helpers/mock-x402'

let mockDb: MockDb
const mockStripe = createMockStripe()
const mockX402 = createMockX402()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

vi.mock('../lib/stripe', () => ({
  RealStripeService: class {
    createCustomer = mockStripe.createCustomer
    createConnectAccount = mockStripe.createConnectAccount
    getAccountStatus = mockStripe.getAccountStatus
    attachPaymentMethod = mockStripe.attachPaymentMethod
    captureEscrowFunds = mockStripe.captureEscrowFunds
    releaseFunds = mockStripe.releaseFunds
    burnFunds = mockStripe.burnFunds
    refundBuyerAndBurnCollateral = mockStripe.refundBuyerAndBurnCollateral
  },
}))

vi.mock('../lib/x402', () => ({
  RealX402Service: class {
    generatePaymentInstructions = mockX402.generatePaymentInstructions
    verifyPayment = mockX402.verifyPayment
    mintMacaroon = mockX402.mintMacaroon
    verifyMacaroon = mockX402.verifyMacaroon
    settleToSeller = mockX402.settleToSeller
    checkBalance = mockX402.checkBalance
    getGatewayAddress = mockX402.getGatewayAddress
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
      stripe_customer_id: null,
      stripe_connected_account_id: null,
      stripe_onboarding_complete: false,
      stripe_default_payment_method: null,
      email: null,
      notification_preferences: null,
      webhook_url: null,
      webhook_secret: null,
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
      stripe_customer_id: null,
      stripe_connected_account_id: null,
      stripe_onboarding_complete: false,
      stripe_default_payment_method: null,
      email: null,
      notification_preferences: null,
      webhook_url: null,
      webhook_secret: null,
    },
  ])
}

function seedX402Escrow(overrides: Record<string, unknown> = {}) {
  const escrow = {
    id: 'escrow-x402-1',
    contract_address: null,
    stripe_escrow_id: null,
    stripe_buyer_pi_id: null,
    stripe_seller_collateral_pi_id: null,
    stripe_transfer_id: null,
    buyer_payment_method_id: null,
    seller_payment_method_id: null,
    buyer_id: 'buyer-id',
    seller_id: 'seller-id',
    amount_cents: 550,
    seller_collateral: 275,
    task_hash: 'abc123',
    task_spec: { type: 'web-search', query: 'test' },
    policy_id: null,
    verification_method: 'buyer_confirm',
    dispute_resolution: 'arbitrate',
    status: 'proposed',
    proof: null,
    deliverable: null,
    timeout_seconds: 3600,
    created_at: new Date().toISOString(),
    funded_at: null,
    completed_at: null,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    funding_mode: 'x402',
    buyer_address: '0x1111111111111111111111111111111111111111',
    seller_address: '0x2222222222222222222222222222222222222222',
    buyer_funded: false,
    seller_funded: false,
    chain_id: 8453,
    tx_hash: null,
    delivery_attempts: 0,
    oracle_fee_cents: 0,
    x402_tx_hash: null,
    x402_macaroon: null,
    x402_settlement_fee_cents: 0,
    x402_seller_payout_tx: null,
    ...overrides,
  }
  mockDb.seedTable('escrows', [escrow])
  return escrow
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /v2/escrow/propose (x402 mode)', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockX402.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
  })

  it('proposes x402 escrow with payment instructions', async () => {
    const body = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 550,
      taskSpec: { type: 'web-search', query: 'test' },
      fundingMode: 'x402',
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/propose', body, buyer)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.fundingMode).toBe('x402')
    expect(json.data.x402PaymentInstructions).toBeDefined()
    const instructions = json.data.x402PaymentInstructions as Record<string, unknown>
    expect(instructions.amountUsdc).toBe('5.50')
    expect(instructions.chainId).toBe(8453)
  })

  it('auto-derives buyer/seller Ethereum addresses for x402', async () => {
    const body = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 1000,
      taskSpec: { type: 'code-review', pr: 42 },
      fundingMode: 'x402',
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/propose', body, buyer)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: { buyerAddress: string; sellerAddress: string } }
    expect(json.data.buyerAddress).toMatch(/^0x[0-9a-f]{40}$/)
    expect(json.data.sellerAddress).toMatch(/^0x[0-9a-f]{40}$/)
  })
})

describe('POST /v2/escrow/:id/x402-pay', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockX402.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
  })

  it('pays for x402 escrow and transitions to active (sandbox)', async () => {
    seedX402Escrow()

    const body = JSON.stringify({ txHash: '0xabcdef1234567890' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-x402-1/x402-pay', body, buyer)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string; x402Macaroon: string } }
    expect(json.data.status).toBe('active')
    expect(json.data.x402Macaroon).toBe('mock_macaroon_escrow-x402-1')
  })

  it('rejects x402-pay for non-x402 escrow', async () => {
    seedX402Escrow({ funding_mode: 'stripe' })

    const body = JSON.stringify({ txHash: '0xabcdef' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-x402-1/x402-pay', body, buyer)
    expect(res.status).toBe(400)
  })

  it('rejects x402-pay for non-buyer', async () => {
    seedX402Escrow()

    const body = JSON.stringify({ txHash: '0xabcdef' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-x402-1/x402-pay', body, seller)
    expect(res.status).toBe(403)
  })

  it('rejects x402-pay for non-proposed escrow', async () => {
    seedX402Escrow({ status: 'active' })

    const body = JSON.stringify({ txHash: '0xabcdef' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-x402-1/x402-pay', body, buyer)
    expect(res.status).toBe(409)
  })

  it('rejects x402-pay for expired proposal', async () => {
    seedX402Escrow({ expires_at: new Date(Date.now() - 1000).toISOString() })

    const body = JSON.stringify({ txHash: '0xabcdef' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-x402-1/x402-pay', body, buyer)
    expect(res.status).toBe(409)
  })

  it('rejects missing txHash', async () => {
    seedX402Escrow()

    const body = JSON.stringify({})
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-x402-1/x402-pay', body, buyer)
    expect(res.status).toBe(400)
  })
})

describe('POST /v2/escrow/:id/confirm (x402 settlement)', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockX402.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
  })

  it('confirms delivery on x402 escrow (sandbox, no settlement)', async () => {
    seedX402Escrow({
      status: 'delivered',
      proof: 'test-proof-hash',
      funded_at: new Date().toISOString(),
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-x402-1/confirm', '{}', buyer)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('released')
  })
})

describe('Stripe fail-fast on propose', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
  })

  it('rejects Stripe propose when buyer has no payment method (production)', async () => {
    // Seed agents without Stripe setup
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
        stripe_customer_id: null,
        stripe_connected_account_id: null,
        stripe_onboarding_complete: false,
        stripe_default_payment_method: null,
        email: null,
        notification_preferences: null,
        webhook_url: null,
        webhook_secret: null,
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
        stripe_customer_id: null,
        stripe_connected_account_id: null,
        stripe_onboarding_complete: false,
        stripe_default_payment_method: null,
        email: null,
        notification_preferences: null,
        webhook_url: null,
        webhook_secret: null,
      },
    ])

    const body = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 1000,
      taskSpec: { type: 'test' },
      fundingMode: 'stripe',
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/propose', body, buyer)
    expect(res.status).toBe(400)

    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('PAYMENT_NOT_CONFIGURED')
  })
})
