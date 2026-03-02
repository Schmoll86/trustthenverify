import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockStripe } from './helpers/mock-stripe'
import { createMockArbitration } from './helpers/mock-arbitration'

let mockDb: MockDb
const mockStripe = createMockStripe()
const mockArbitration = createMockArbitration()

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

vi.mock('../lib/arbitration-service', () => ({
  RealArbitrationService: class {
    arbitrate = mockArbitration.arbitrate
  },
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'test-gateway-key',
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_mock',
  OPENROUTER_API_KEY: 'test-openrouter-key',
  ARBITRATION_MODEL: 'test-model',
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

function seedTestData(buyer: { publicKey: string }, seller: { publicKey: string }) {
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
      stripe_customer_id: 'cus_buyer',
      stripe_connected_account_id: null,
      stripe_onboarding_complete: false,
      stripe_default_payment_method: 'pm_buyer',
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
      capabilities: [],
      metadata: {},
      parent_id: null,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      stripe_customer_id: 'cus_seller',
      stripe_connected_account_id: 'acct_seller',
      stripe_onboarding_complete: true,
      stripe_default_payment_method: 'pm_seller',
      email: null,
      notification_preferences: null,
      webhook_url: null,
      webhook_secret: null,
    },
  ])
}

function seedActiveEscrow(opts?: { disputeResolution?: string }) {
  const expiresAt = new Date(Date.now() + 3600_000).toISOString()
  mockDb.seedTable('escrows', [
    {
      id: 'escrow-1',
      buyer_id: 'buyer-id',
      seller_id: 'seller-id',
      amount_cents: 1000,
      seller_collateral: 200,
      task_hash: 'hash',
      task_spec: { description: 'Write a poem' },
      policy_id: null,
      verification_method: 'buyer_confirm',
      dispute_resolution: opts?.disputeResolution ?? 'arbitrate',
      status: 'active',
      proof: null,
      deliverable: { text: 'Here is a poem about testing' },
      created_at: new Date().toISOString(),
      funded_at: new Date().toISOString(),
      completed_at: null,
      expires_at: expiresAt,
      delivery_attempts: 0,
      timeout_seconds: 3600,
      funding_mode: 'stripe',
      buyer_address: null,
      seller_address: null,
      buyer_funded: false,
      seller_funded: false,
      chain_id: null,
      tx_hash: null,
      contract_address: null,
      stripe_escrow_id: 'pi_buyer_mock',
      stripe_buyer_pi_id: 'pi_buyer_mock',
      stripe_seller_collateral_pi_id: 'pi_collateral_mock',
      stripe_transfer_id: null,
      buyer_payment_method_id: null,
      seller_payment_method_id: null,
      oracle_fee_cents: 0,
      x402_tx_hash: null,
      x402_macaroon: null,
      x402_settlement_fee_cents: 0,
      x402_seller_payout_tx: null,
    },
  ])
  mockDb.seedTable('disputes', [])
  mockDb.seedTable('verifications', [])
  mockDb.seedTable('policies', [])
}

describe('Dispute Arbitration', () => {
  let buyer: { publicKey: string; privateKey: string }
  let seller: { publicKey: string; privateKey: string }

  beforeEach(async () => {
    buyer = await generateKeypair()
    seller = await generateKeypair()
    mockDb = createMockDb()
    mockStripe.reset()
    mockArbitration.reset()
    seedTestData(buyer, seller)
    seedActiveEscrow()
  })

  it('dispute with arbitrate mode → disputed → buyer_wins → failed', async () => {
    mockArbitration.setRuling({
      ruling: 'buyer_wins',
      rationale: 'Deliverable was not submitted',
      confidence: 0.95,
    })

    const res = await makeSignedRequest(
      'POST',
      '/v2/escrow/escrow-1/dispute',
      JSON.stringify({ reason: 'Never delivered' }),
      buyer,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { data: { status: string } }
    expect(body.data.status).toBe('failed')

    // Stripe: buyer refunded minus 10%, collateral kept
    const refundCall = mockStripe.calls.find(c => c.method === 'refundBuyerAndBurnCollateral')
    expect(refundCall).toBeTruthy()
    expect(refundCall!.params.buyerRefundCents).toBe(900) // 1000 - 10%

    // Dispute record created
    const disputes = mockDb.getTable('disputes').rows
    expect(disputes.length).toBe(1)
    expect(disputes[0].ruling).toBe('buyer_wins')
    expect(disputes[0].status).toBe('resolved')
  })

  it('dispute with arbitrate mode → seller_wins → released', async () => {
    mockArbitration.setRuling({
      ruling: 'seller_wins',
      rationale: 'Deliverable satisfies the spec',
      confidence: 0.85,
    })

    const res = await makeSignedRequest(
      'POST',
      '/v2/escrow/escrow-1/dispute',
      JSON.stringify({ reason: 'Quality too low' }),
      buyer,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { data: { status: string } }
    expect(body.data.status).toBe('released')

    // Stripe: transfer to seller minus 10%, collateral returned
    const releaseCall = mockStripe.calls.find(c => c.method === 'releaseFunds')
    expect(releaseCall).toBeTruthy()
    expect(releaseCall!.params.sellerAmountCents).toBe(900) // 1000 - 10%
  })

  it('10% fee math is correct', async () => {
    // Change amount to 1500 to test rounding
    const escrows = mockDb.getTable('escrows').rows
    escrows[0].amount_cents = 1500

    mockArbitration.setRuling({
      ruling: 'buyer_wins',
      rationale: 'Test',
      confidence: 0.9,
    })

    const res = await makeSignedRequest(
      'POST',
      '/v2/escrow/escrow-1/dispute',
      JSON.stringify({ reason: 'Test' }),
      buyer,
    )

    expect(res.status).toBe(200)
    const refundCall = mockStripe.calls.find(c => c.method === 'refundBuyerAndBurnCollateral')
    expect(refundCall!.params.buyerRefundCents).toBe(1350) // 1500 - 150 (10%)
  })

  it('only buyer or seller can dispute', async () => {
    const outsider = await generateKeypair()
    // Register outsider
    mockDb.getTable('agents').rows.push({
      id: 'outsider-id',
      public_key: outsider.publicKey,
      endpoint: null,
      name: 'outsider',
      capabilities: [],
      metadata: {},
      parent_id: null,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      stripe_customer_id: null,
      stripe_connected_account_id: null,
      stripe_onboarding_complete: false,
      stripe_default_payment_method: null,
    })

    const res = await makeSignedRequest(
      'POST',
      '/v2/escrow/escrow-1/dispute',
      JSON.stringify({ reason: 'I want in' }),
      outsider,
    )

    expect(res.status).toBe(403)
  })

  it('cannot dispute terminal escrow', async () => {
    const escrows = mockDb.getTable('escrows').rows
    escrows[0].status = 'released'

    const res = await makeSignedRequest(
      'POST',
      '/v2/escrow/escrow-1/dispute',
      JSON.stringify({ reason: 'Too late' }),
      buyer,
    )

    expect(res.status).toBe(409)
  })

  it('burn mode still works (opt-in)', async () => {
    // Reset with burn mode
    mockDb = createMockDb()
    seedTestData(buyer, seller)
    seedActiveEscrow({ disputeResolution: 'burn' })

    const res = await makeSignedRequest(
      'POST',
      '/v2/escrow/escrow-1/dispute',
      JSON.stringify({ reason: 'Nuclear option' }),
      buyer,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { data: { status: string } }
    expect(body.data.status).toBe('burned')

    const burnCall = mockStripe.calls.find(c => c.method === 'burnFunds')
    expect(burnCall).toBeTruthy()
  })

  it('seller can also file dispute', async () => {
    mockArbitration.setRuling({
      ruling: 'seller_wins',
      rationale: 'Seller is right',
      confidence: 0.9,
    })

    const res = await makeSignedRequest(
      'POST',
      '/v2/escrow/escrow-1/dispute',
      JSON.stringify({ reason: 'Buyer not responding' }),
      seller,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { data: { status: string } }
    expect(body.data.status).toBe('released')
  })

  it('LLM failure → 502, dispute stays open for retry', async () => {
    mockArbitration.setError(new Error('LLM timeout'))

    const res = await makeSignedRequest(
      'POST',
      '/v2/escrow/escrow-1/dispute',
      JSON.stringify({ reason: 'Test' }),
      buyer,
    )

    expect(res.status).toBe(502)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('ARBITRATION_FAILED')

    // Escrow should be in disputed state (not terminal)
    const escrows = mockDb.getTable('escrows').rows
    expect(escrows[0].status).toBe('disputed')
  })

  it('GET /disputes/:id returns dispute with ruling', async () => {
    mockArbitration.setRuling({
      ruling: 'buyer_wins',
      rationale: 'No delivery',
      confidence: 0.95,
    })

    // File dispute first
    await makeSignedRequest(
      'POST',
      '/v2/escrow/escrow-1/dispute',
      JSON.stringify({ reason: 'Never delivered' }),
      buyer,
    )

    const disputes = mockDb.getTable('disputes').rows
    const disputeId = disputes[0].id

    const res = await makeSignedRequest(
      'GET',
      `/v2/disputes/${disputeId}`,
      '',
      buyer,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { data: { ruling: string; status: string; arbitrationDetails?: unknown } }
    expect(body.data.ruling).toBe('buyer_wins')
    expect(body.data.status).toBe('resolved')
    expect(body.data.arbitrationDetails).toBeTruthy()
  })

  it('POST /disputes/:id/ruling returns 403', async () => {
    const res = await makeSignedRequest(
      'POST',
      '/v2/disputes/some-id/ruling',
      JSON.stringify({ ruling: 'buyer_wins' }),
      buyer,
    )

    expect(res.status).toBe(403)
  })

  it('default dispute_resolution is now arbitrate', async () => {
    // Propose a new escrow and check default
    const res = await makeSignedRequest(
      'POST',
      '/v2/escrow/propose',
      JSON.stringify({
        seller: seller.publicKey,
        amountCents: 500,
        taskSpec: { test: true },
      }),
      buyer,
    )

    expect(res.status).toBe(201)
    const body = await res.json() as { data: { disputeResolution: string } }
    expect(body.data.disputeResolution).toBe('arbitrate')
  })

  it('can dispute delivered escrow', async () => {
    const escrows = mockDb.getTable('escrows').rows
    escrows[0].status = 'delivered'

    mockArbitration.setRuling({
      ruling: 'buyer_wins',
      rationale: 'Poor quality',
      confidence: 0.8,
    })

    const res = await makeSignedRequest(
      'POST',
      '/v2/escrow/escrow-1/dispute',
      JSON.stringify({ reason: 'Low quality delivery' }),
      buyer,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { data: { status: string } }
    expect(body.data.status).toBe('failed')
  })
})
