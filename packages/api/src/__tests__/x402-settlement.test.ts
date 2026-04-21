/**
 * Tests for x402 USDC settlement fee calculation and payout amounts.
 * Uses automated_reasoning verification (via deliver route) to trigger
 * settlement, since the confirm route skips settlement in sandbox mode.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockStripe } from './helpers/mock-stripe'
import { createMockX402 } from './helpers/mock-x402'
import { createMockGateway } from './helpers/mock-gateway'

let mockDb: MockDb
const mockStripe = createMockStripe()
const mockX402 = createMockX402()
const mockGateway = createMockGateway()

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

vi.mock('../lib/gateway', () => ({
  RealGatewayService: class {
    verify = mockGateway.verify
  },
}))

const baseEnv = {
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
  env: Record<string, unknown> = baseEnv,
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
    amount_cents: 1000,
    seller_collateral: 500,
    task_hash: 'abc123',
    task_spec: { type: 'web-search', query: 'test' },
    policy_id: 'pol-1',
    verification_method: 'automated_reasoning',
    dispute_resolution: 'arbitrate',
    status: 'active',
    proof: null,
    deliverable: null,
    timeout_seconds: 3600,
    created_at: new Date().toISOString(),
    funded_at: new Date().toISOString(),
    completed_at: null,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    funding_mode: 'x402',
    buyer_address: '0x1111111111111111111111111111111111111111',
    seller_address: '0x2222222222222222222222222222222222222222',
    buyer_funded: true,
    seller_funded: false,
    chain_id: 8453,
    tx_hash: null,
    delivery_attempts: 0,
    oracle_fee_cents: 0,
    x402_tx_hash: '0xpaid',
    x402_macaroon: 'mock_macaroon_escrow-x402-1',
    x402_settlement_fee_cents: 0,
    x402_seller_payout_tx: null,
    ...overrides,
  }
  mockDb.seedTable('escrows', [escrow])
  return escrow
}

function setGatewayPass() {
  mockGateway.setResult({
    result: 'pass',
    constraintsTotal: 2,
    constraintsPassed: 2,
    failures: [],
    gatewaySignature: 'sig_x402_settle',
    verifiedAt: new Date().toISOString(),
  })
}

describe('x402 settlement fee calculation', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockX402.reset()
    mockStripe.reset()
    mockGateway.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
    mockDb.seedTable('verifications', [])
  })

  it('proposes x402 escrow with correct USDC payment instructions', async () => {
    const body = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 1000,
      taskSpec: { type: 'web-search', query: 'test' },
      fundingMode: 'x402',
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/propose', body, buyer)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.fundingMode).toBe('x402')
    const instructions = json.data.x402PaymentInstructions as Record<string, unknown>
    expect(instructions.amountUsdc).toBe('10.00')
  })

  it('x402-pay with txHash transitions to active and mints macaroon', async () => {
    seedX402Escrow({ status: 'proposed', funded_at: null, proof: null })

    const body = JSON.stringify({ txHash: '0xabc123' })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-x402-1/x402-pay', body, buyer)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string; x402Macaroon: string } }
    expect(json.data.status).toBe('active')
    expect(json.data.x402Macaroon).toMatch(/^mock_macaroon_/)
  })

  it('$10.00 escrow: settlement fee = $0.10 (1%), seller net = $9.90', async () => {
    seedX402Escrow({ amount_cents: 1000 })
    setGatewayPass()

    const body = JSON.stringify({ deliverable: { results: ['a', 'b', 'c'] } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-x402-1/deliver', body, seller)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('released')

    // settleToSeller: mock records amountUsdc as string of BigInt
    // Net: 1000 - 10 = 990 cents * 10000 = 9900000
    const settleCall = mockX402.calls.find(c => c.method === 'settleToSeller')
    expect(settleCall).toBeDefined()
    expect(settleCall!.params.amountUsdc).toBe('9900000')

    const escrow = mockDb.getTable('escrows').rows[0]
    expect(escrow.x402_settlement_fee_cents).toBe(10)
  })

  it('$1.00 escrow: settlement fee = $0.01 (1%), seller net = $0.99', async () => {
    seedX402Escrow({ amount_cents: 100 })
    setGatewayPass()

    const body = JSON.stringify({ deliverable: { results: ['a'] } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-x402-1/deliver', body, seller)
    expect(res.status).toBe(200)

    // Net: 100 - 1 = 99 cents * 10000 = 990000
    const settleCall = mockX402.calls.find(c => c.method === 'settleToSeller')
    expect(settleCall).toBeDefined()
    expect(settleCall!.params.amountUsdc).toBe('990000')

    const escrow = mockDb.getTable('escrows').rows[0]
    expect(escrow.x402_settlement_fee_cents).toBe(1)
  })

  it('custom 2% fee (200 BPS): $10.00 escrow -> fee = $0.20', async () => {
    seedX402Escrow({ amount_cents: 1000 })
    setGatewayPass()

    const envWith2Pct = { ...baseEnv, X402_SETTLEMENT_FEE_BPS: '200' }
    const body = JSON.stringify({ deliverable: { results: ['a', 'b'] } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-x402-1/deliver', body, seller, envWith2Pct)
    expect(res.status).toBe(200)

    // Net: 1000 - 20 = 980 cents * 10000 = 9800000
    const settleCall = mockX402.calls.find(c => c.method === 'settleToSeller')
    expect(settleCall).toBeDefined()
    expect(settleCall!.params.amountUsdc).toBe('9800000')

    const escrow = mockDb.getTable('escrows').rows[0]
    expect(escrow.x402_settlement_fee_cents).toBe(20)
  })

  it('settleToSeller receives correct seller address and net amount', async () => {
    seedX402Escrow({ amount_cents: 550 })
    setGatewayPass()

    const body = JSON.stringify({ deliverable: { results: ['a'] } })
    const res = await makeSignedRequest('POST', '/v2/escrow/escrow-x402-1/deliver', body, seller)
    expect(res.status).toBe(200)

    // Fee: Math.round(550 * 100 / 10000) = Math.round(5.5) = 6 cents
    // Net: 550 - 6 = 544 cents * 10000 = 5440000
    const settleCall = mockX402.calls.find(c => c.method === 'settleToSeller')
    expect(settleCall).toBeDefined()
    expect(settleCall!.params.sellerAddress).toBe('0x2222222222222222222222222222222222222222')
    expect(settleCall!.params.amountUsdc).toBe('5440000')
  })

  it('verify macaroon endpoint returns valid response with payload', async () => {
    const body = JSON.stringify({ macaroon: 'mock_macaroon_escrow-x402-1' })
    const res = await app.request('/v2/x402/verify-macaroon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, baseEnv)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { valid: boolean; payload: { escrowId: string } } }
    expect(json.data.valid).toBe(true)
    expect(json.data.payload.escrowId).toBe('escrow-x402-1')
  })
})
