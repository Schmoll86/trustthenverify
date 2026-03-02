import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockStripe } from './helpers/mock-stripe'
import { createMockOnchain } from './helpers/mock-onchain'

let mockDb: MockDb
const mockStripe = createMockStripe()
const mockOnchain = createMockOnchain()

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

vi.mock('../lib/onchain', () => ({
  RealOnchainService: class {
    deployEscrow = mockOnchain.deployEscrow
    checkFunding = mockOnchain.checkFunding
    gatewayRelease = mockOnchain.gatewayRelease
    gatewayFail = mockOnchain.gatewayFail
    triggerTimeout = mockOnchain.triggerTimeout
    getContractState = mockOnchain.getContractState
  },
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'test-gateway-key',
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_mock',
  BASE_RPC_URL: 'http://localhost:8545',
  ESCROW_FACTORY_ADDRESS: '0x' + '11'.repeat(20),
  BASE_CHAIN_ID: '84532',
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
      stripe_customer_id: 'cus_buyer_test',
      stripe_connected_account_id: null,
      stripe_onboarding_complete: false,
      stripe_default_payment_method: 'pm_buyer_test',
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
      stripe_customer_id: 'cus_seller_test',
      stripe_connected_account_id: 'acct_seller_test',
      stripe_onboarding_complete: true,
      stripe_default_payment_method: 'pm_seller_test',
      email: null,
      notification_preferences: null,
      webhook_url: null,
      webhook_secret: null,
    },
  ])
}

describe('On-chain escrow lifecycle', () => {
  const buyer = generateKeypair()
  const seller = generateKeypair()

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    mockOnchain.reset()
    seedAgents(buyer, seller)
  })

  it('proposes an on-chain escrow with addresses', async () => {
    const body = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 5000,
      sellerCollateral: 500,
      taskSpec: { task: 'test' },
      fundingMode: 'onchain',
      buyerAddress: '0x' + 'aa'.repeat(20),
      sellerAddress: '0x' + 'bb'.repeat(20),
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/propose', body, buyer)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.fundingMode).toBe('onchain')
    expect(json.data.buyerAddress).toBe('0x' + 'aa'.repeat(20))
    expect(json.data.sellerAddress).toBe('0x' + 'bb'.repeat(20))
    expect(json.data.status).toBe('proposed')
    expect(json.data.chainId).toBe(84532)
  })

  it('rejects on-chain proposal without addresses', async () => {
    const body = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 5000,
      sellerCollateral: 500,
      taskSpec: { task: 'test' },
      fundingMode: 'onchain',
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/propose', body, buyer)
    expect(res.status).toBe(400)
  })

  it('defaults to stripe funding mode', async () => {
    const body = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 5000,
      sellerCollateral: 500,
      taskSpec: { task: 'test' },
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/propose', body, buyer)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.fundingMode).toBe('stripe')
    expect(json.data.buyerAddress).toBeNull()
  })

  it('accepts on-chain escrow: proposed → accepted + deploys contract', async () => {
    const escrowId = 'esc-onchain-1'
    const futureExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString()

    mockDb.seedTable('escrows', [{
      id: escrowId,
      buyer_id: 'buyer-id',
      seller_id: 'seller-id',
      amount_cents: 5000,
      seller_collateral: 500,
      task_hash: 'hash',
      task_spec: { task: 'test' },
      status: 'proposed',
      verification_method: 'buyer_confirm',
      dispute_resolution: 'burn',
      timeout_seconds: 3600,
      expires_at: futureExpiry,
      delivery_attempts: 0,
      funding_mode: 'onchain',
      buyer_address: '0x' + 'aa'.repeat(20),
      seller_address: '0x' + 'bb'.repeat(20),
      buyer_funded: false,
      seller_funded: false,
      chain_id: 84532,
    }])

    const res = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/accept`, '{}', seller)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.status).toBe('accepted')
    expect(json.data.contractAddress).toBeTruthy()
    expect(json.data.txHash).toBeTruthy()
    expect(mockOnchain.calls.length).toBe(1)
    expect(mockOnchain.calls[0].method).toBe('deployEscrow')
  })

  it('stripe accept still works (backward compat)', async () => {
    const escrowId = 'esc-stripe-1'
    const futureExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString()

    mockDb.seedTable('escrows', [{
      id: escrowId,
      buyer_id: 'buyer-id',
      seller_id: 'seller-id',
      amount_cents: 5000,
      seller_collateral: 500,
      task_hash: 'hash',
      task_spec: { task: 'test' },
      status: 'proposed',
      verification_method: 'buyer_confirm',
      dispute_resolution: 'burn',
      timeout_seconds: 3600,
      expires_at: futureExpiry,
      delivery_attempts: 0,
      funding_mode: 'stripe',
      buyer_funded: false,
      seller_funded: false,
      buyer_payment_method_id: null,
      stripe_buyer_pi_id: null,
      stripe_seller_collateral_pi_id: null,
      stripe_transfer_id: null,
    }])

    const res = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/accept`, '{}', seller)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.status).toBe('active')
    expect(mockStripe.calls.length).toBe(1)
    expect(mockStripe.calls[0].method).toBe('captureEscrowFunds')
    expect(mockStripe.calls[0].params).toHaveProperty('buyerCustomerId', 'cus_buyer_test')
    expect(mockOnchain.calls.length).toBe(0)
  })

  it('fund endpoint checks on-chain state and activates', async () => {
    const escrowId = 'esc-onchain-fund'
    const futureExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString()

    mockDb.seedTable('escrows', [{
      id: escrowId,
      buyer_id: 'buyer-id',
      seller_id: 'seller-id',
      amount_cents: 5000,
      seller_collateral: 500,
      task_hash: 'hash',
      task_spec: { task: 'test' },
      status: 'accepted',
      verification_method: 'buyer_confirm',
      dispute_resolution: 'burn',
      timeout_seconds: 3600,
      expires_at: futureExpiry,
      delivery_attempts: 0,
      funding_mode: 'onchain',
      contract_address: '0x' + 'cc'.repeat(20),
      buyer_address: '0x' + 'aa'.repeat(20),
      seller_address: '0x' + 'bb'.repeat(20),
      buyer_funded: false,
      seller_funded: false,
      chain_id: 84532,
    }])

    const res = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/fund`, '{}', buyer)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Record<string, unknown> }
    // Mock returns both funded by default
    expect(json.data.status).toBe('active')
    expect(json.data.buyerFunded).toBe(true)
    expect(json.data.sellerFunded).toBe(true)
    expect(json.data.fundedAt).toBeTruthy()
    expect(mockOnchain.calls[0].method).toBe('checkFunding')
  })

  it('fund endpoint rejects stripe escrows', async () => {
    const escrowId = 'esc-stripe-nofund'

    mockDb.seedTable('escrows', [{
      id: escrowId,
      buyer_id: 'buyer-id',
      seller_id: 'seller-id',
      amount_cents: 5000,
      seller_collateral: 500,
      task_hash: 'hash',
      task_spec: { task: 'test' },
      status: 'active',
      verification_method: 'buyer_confirm',
      dispute_resolution: 'burn',
      timeout_seconds: 3600,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      delivery_attempts: 0,
      funding_mode: 'stripe',
    }])

    const res = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/fund`, '{}', buyer)
    expect(res.status).toBe(400)
  })

  it('full on-chain lifecycle: propose → accept → fund → deliver → confirm → release', async () => {
    // 1. Propose
    const proposeBody = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 5000,
      sellerCollateral: 500,
      taskSpec: { task: 'full lifecycle' },
      fundingMode: 'onchain',
      buyerAddress: '0x' + 'aa'.repeat(20),
      sellerAddress: '0x' + 'bb'.repeat(20),
    })
    const proposeRes = await makeSignedRequest('POST', '/v2/escrow/propose', proposeBody, buyer)
    expect(proposeRes.status).toBe(201)
    const proposed = (await proposeRes.json() as { data: { id: string } }).data
    const escrowId = proposed.id

    // 2. Accept
    const acceptRes = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/accept`, '{}', seller)
    expect(acceptRes.status).toBe(200)
    const accepted = (await acceptRes.json() as { data: { status: string } }).data
    expect(accepted.status).toBe('accepted')

    // 3. Fund
    const fundRes = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/fund`, '{}', buyer)
    expect(fundRes.status).toBe(200)
    const funded = (await fundRes.json() as { data: { status: string } }).data
    expect(funded.status).toBe('active')

    // 4. Deliver
    const deliverBody = JSON.stringify({ deliverable: { result: 'done' } })
    const deliverRes = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/deliver`, deliverBody, seller)
    expect(deliverRes.status).toBe(200)

    // 5. Confirm
    mockDb.seedTable('verifications', [])
    const confirmRes = await makeSignedRequest('POST', `/v2/escrow/${escrowId}/confirm`, '{}', buyer)
    expect(confirmRes.status).toBe(200)
    const released = (await confirmRes.json() as { data: { status: string } }).data
    expect(released.status).toBe('released')
  })
})
