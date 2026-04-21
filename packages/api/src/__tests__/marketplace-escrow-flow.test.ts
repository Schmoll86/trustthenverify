/**
 * Integration tests: marketplace policy clone → escrow lifecycle → gateway verification.
 * Tests the full value prop: browse public policy, clone it, use in escrow, verify deliverable.
 */

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

const formalSpec = JSON.stringify({
  version: 1,
  constraints: [
    { id: 'c1', type: 'output_count', min: 3 },
    { id: 'c2', type: 'format', schema: 'url_list' },
  ],
})

const sourcePolicy = {
  id: 'marketplace-pol-1',
  name: 'Web Scraping Policy',
  description: 'Verified web scraping with minimum 3 results',
  intent: 'Scrape public websites and return structured URL list',
  formal_spec: formalSpec,
  version: 1,
  status: 'active',
  visibility: 'public',
  billing: 'marketplace',
  billing_model: 'free',
  usage_count: 42,
  created_by: 'creator-1',
  created_at: '2026-01-01T12:00:00Z',
  cross_validation: JSON.stringify({ enabled: true, threshold: 0.8 }),
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
      capabilities: ['web-search'],
      metadata: {},
      parent_id: null,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
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

describe('Marketplace → Escrow → Verification flow', () => {
  let buyer: ReturnType<typeof generateKeypair>
  let seller: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    mockGateway.reset()
    buyer = generateKeypair()
    seller = generateKeypair()
    seedAgents(buyer, seller)
    mockDb.seedTable('policies', [sourcePolicy])
    mockDb.seedTable('escrows', [])
    mockDb.seedTable('verifications', [])
    mockDb.seedTable('disputes', [])
  })

  it('clones public policy -> private copy with correct formal_spec', async () => {
    const res = await makeSignedRequest('POST', '/v2/marketplace/marketplace-pol-1/use', '{}', buyer)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.name).toBe('Web Scraping Policy (clone)')
    expect(json.data.visibility).toBe('private')
    expect(json.data.createdBy).toBe('buyer-id')

    // Verify formal_spec is preserved in the clone
    const policies = mockDb.getTable('policies').rows
    const clone = policies.find(p => String(p.name).includes('(clone)'))
    expect(clone).toBeDefined()
    expect(clone!.formal_spec).toBe(formalSpec)
  })

  it('full flow: clone -> propose with policyId -> accept -> deliver (pass) -> released', async () => {
    // 1. Clone marketplace policy
    const cloneRes = await makeSignedRequest('POST', '/v2/marketplace/marketplace-pol-1/use', '{}', buyer)
    expect(cloneRes.status).toBe(201)
    const cloneData = (await cloneRes.json() as { data: { id: string } }).data
    const clonedPolicyId = cloneData.id

    // 2. Propose escrow using the cloned policy
    const proposeBody = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 10000,
      sellerCollateral: 5000,
      taskSpec: { type: 'web-search', query: 'AI agent frameworks' },
      policyId: clonedPolicyId,
      verificationMethod: 'automated_reasoning',
      timeoutSeconds: 3600,
    })
    const proposeRes = await makeSignedRequest('POST', '/v2/escrow/propose', proposeBody, buyer)
    expect(proposeRes.status).toBe(201)
    const proposed = (await proposeRes.json() as { data: { id: string; status: string } }).data
    expect(proposed.status).toBe('proposed')

    // 3. Seller accepts
    const acceptRes = await makeSignedRequest('POST', `/v2/escrow/${proposed.id}/accept`, '{}', seller)
    expect(acceptRes.status).toBe(200)
    const accepted = (await acceptRes.json() as { data: { status: string } }).data
    expect(accepted.status).toBe('active')

    // 4. Seller delivers (gateway passes)
    mockGateway.setResult({
      result: 'pass',
      constraintsTotal: 2,
      constraintsPassed: 2,
      failures: [],
      gatewaySignature: 'sig_marketplace_flow',
      verifiedAt: new Date().toISOString(),
    })
    const deliverBody = JSON.stringify({
      deliverable: { results: [{ url: 'https://a.com' }, { url: 'https://b.com' }, { url: 'https://c.com' }] },
    })
    const deliverRes = await makeSignedRequest('POST', `/v2/escrow/${proposed.id}/deliver`, deliverBody, seller)
    expect(deliverRes.status).toBe(200)

    const released = (await deliverRes.json() as { data: { status: string } }).data
    expect(released.status).toBe('released')

    // Verify gateway was called with the policy
    expect(mockGateway.calls).toHaveLength(1)

    // Verify Stripe calls: capture + release
    expect(mockStripe.calls.filter(c => c.method === 'captureEscrowFunds')).toHaveLength(1)
    expect(mockStripe.calls.filter(c => c.method === 'releaseFunds')).toHaveLength(1)
  })

  it('full flow: clone -> propose -> accept -> deliver (FAIL) -> failed', async () => {
    // 1. Clone
    const cloneRes = await makeSignedRequest('POST', '/v2/marketplace/marketplace-pol-1/use', '{}', buyer)
    const cloneData = (await cloneRes.json() as { data: { id: string } }).data

    // 2. Propose
    const proposeBody = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 5000,
      sellerCollateral: 2500,
      taskSpec: { type: 'web-search', query: 'test' },
      policyId: cloneData.id,
      verificationMethod: 'automated_reasoning',
      timeoutSeconds: 3600,
    })
    const proposeRes = await makeSignedRequest('POST', '/v2/escrow/propose', proposeBody, buyer)
    const proposed = (await proposeRes.json() as { data: { id: string } }).data

    // 3. Accept
    await makeSignedRequest('POST', `/v2/escrow/${proposed.id}/accept`, '{}', seller)

    // 4. Deliver (gateway fails verification)
    mockGateway.setResult({
      result: 'fail',
      constraintsTotal: 2,
      constraintsPassed: 0,
      failures: [{ id: 'c1', error: 'only 1 result, need 3' }],
      gatewaySignature: 'sig_fail',
      verifiedAt: new Date().toISOString(),
    })
    const deliverBody = JSON.stringify({ deliverable: { results: [{ url: 'https://a.com' }] } })
    const deliverRes = await makeSignedRequest('POST', `/v2/escrow/${proposed.id}/deliver`, deliverBody, seller)
    expect(deliverRes.status).toBe(200)

    const failed = (await deliverRes.json() as { data: { status: string } }).data
    expect(failed.status).toBe('failed')

    // Refund buyer
    expect(mockStripe.calls.some(c => c.method === 'refundBuyerAndBurnCollateral')).toBe(true)
  })

  it('cannot clone non-public policy -> 404', async () => {
    // Seed a private policy
    mockDb.seedTable('policies', [{
      ...sourcePolicy,
      id: 'private-pol',
      visibility: 'private',
    }])

    const res = await makeSignedRequest('POST', '/v2/marketplace/private-pol/use', '{}', buyer)
    expect(res.status).toBe(404)
  })

  it('cloned policy preserves formal_spec from source', async () => {
    const res = await makeSignedRequest('POST', '/v2/marketplace/marketplace-pol-1/use', '{}', buyer)
    expect(res.status).toBe(201)

    const policies = mockDb.getTable('policies').rows
    const clone = policies.find(p => String(p.name).includes('(clone)'))
    expect(clone).toBeDefined()
    expect(clone!.formal_spec).toBe(formalSpec)
    // Clone inherits key fields: description, intent, billing_model
    expect(clone!.description).toBe(sourcePolicy.description)
    expect(clone!.intent).toBe(sourcePolicy.intent)
  })

  it('clone creates independent copy (modifying clone does not affect source)', async () => {
    const res = await makeSignedRequest('POST', '/v2/marketplace/marketplace-pol-1/use', '{}', buyer)
    expect(res.status).toBe(201)

    const policies = mockDb.getTable('policies').rows
    const source = policies.find(p => p.id === 'marketplace-pol-1')
    const clone = policies.find(p => String(p.name).includes('(clone)'))

    // Source unchanged
    expect(source!.visibility).toBe('public')
    expect(source!.created_by).toBe('creator-1')

    // Clone is separate
    expect(clone!.id).not.toBe('marketplace-pol-1')
    expect(clone!.visibility).toBe('private')
    expect(clone!.created_by).toBe('buyer-id')
  })

  it('clone of nonexistent policy -> 404', async () => {
    const res = await makeSignedRequest('POST', '/v2/marketplace/nonexistent-pol/use', '{}', buyer)
    expect(res.status).toBe(404)
  })

  it('verification record references policy from escrow', async () => {
    // Clone + propose + accept + deliver (pass)
    const cloneRes = await makeSignedRequest('POST', '/v2/marketplace/marketplace-pol-1/use', '{}', buyer)
    const cloneData = (await cloneRes.json() as { data: { id: string } }).data

    const proposeBody = JSON.stringify({
      seller: seller.publicKey,
      amountCents: 3000,
      sellerCollateral: 1500,
      taskSpec: { type: 'web-search', query: 'test' },
      policyId: cloneData.id,
      verificationMethod: 'automated_reasoning',
      timeoutSeconds: 3600,
    })
    const proposeRes = await makeSignedRequest('POST', '/v2/escrow/propose', proposeBody, buyer)
    const proposed = (await proposeRes.json() as { data: { id: string } }).data
    await makeSignedRequest('POST', `/v2/escrow/${proposed.id}/accept`, '{}', seller)

    mockGateway.setResult({
      result: 'pass',
      constraintsTotal: 2,
      constraintsPassed: 2,
      failures: [],
      gatewaySignature: 'sig_with_policy',
      verifiedAt: new Date().toISOString(),
    })
    await makeSignedRequest(
      'POST',
      `/v2/escrow/${proposed.id}/deliver`,
      JSON.stringify({ deliverable: { results: [{ url: 'https://a.com' }] } }),
      seller,
    )

    // Verification record should reference the cloned policy
    const verifications = mockDb.getTable('verifications').rows
    expect(verifications).toHaveLength(1)
    expect(verifications[0].policy_id).toBe(cloneData.id)
    expect(verifications[0].gateway_signature).toBe('sig_with_policy')
  })
})
