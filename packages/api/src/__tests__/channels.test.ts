import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'

let mockDb: MockDb

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

vi.mock('../lib/stripe', () => ({
  RealStripeService: class {},
}))
vi.mock('../lib/onchain', () => ({
  RealOnchainService: class {},
}))
vi.mock('../lib/gateway', () => ({
  RealGatewayService: class {},
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'test-gateway-key',
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_mock',
}

const buyer = generateKeypair()
const seller = generateKeypair()
const buyerAgentId = crypto.randomUUID()
const sellerAgentId = crypto.randomUUID()

function seedAgents() {
  mockDb.seedTable('agents', [
    { id: buyerAgentId, public_key: buyer.publicKey, name: 'buyer', capabilities: [], metadata: {}, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), stripe_customer_id: null, stripe_connected_account_id: null, stripe_onboarding_complete: false, stripe_default_payment_method: null },
    { id: sellerAgentId, public_key: seller.publicKey, name: 'seller', capabilities: [], metadata: {}, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), stripe_customer_id: null, stripe_connected_account_id: null, stripe_onboarding_complete: false, stripe_default_payment_method: null },
  ])
}

async function authedRequest(
  method: string,
  path: string,
  body: unknown,
  keypair: typeof buyer,
) {
  const bodyStr = body ? JSON.stringify(body) : ''
  const timestamp = Math.floor(Date.now() / 1000)
  const sigPath = path.replace('/v2', '')
  const signature = await signRequest(keypair.privateKey, method, sigPath, bodyStr, timestamp)

  return app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Pubkey': keypair.publicKey,
      'X-Agent-Timestamp': String(timestamp),
      'X-Agent-Signature': signature,
    },
    body: method === 'GET' ? undefined : bodyStr || undefined,
  }, env)
}

describe('Payment channel routes', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    seedAgents()
  })

  it('POST /v2/channels — registers a channel', async () => {
    const res = await authedRequest('POST', '/v2/channels', {
      channelAddress: '0x' + 'ab'.repeat(20),
      counterparty: seller.publicKey,
      depositAmount: 1000,
      chainId: 84532,
      expiryAt: '2026-12-31T23:59:59Z',
    }, buyer)

    expect(res.status).toBe(201)
    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.channelAddress).toBe('0x' + 'ab'.repeat(20))
    expect(json.data.status).toBe('open')
  })

  it('POST /v2/channels — missing fields returns 400', async () => {
    const res = await authedRequest('POST', '/v2/channels', {
      channelAddress: '0x' + 'ab'.repeat(20),
    }, buyer)

    expect(res.status).toBe(400)
  })

  it('POST /v2/channels — unknown counterparty returns 404', async () => {
    const unknown = generateKeypair()
    const res = await authedRequest('POST', '/v2/channels', {
      channelAddress: '0x' + 'cd'.repeat(20),
      counterparty: unknown.publicKey,
      depositAmount: 500,
      chainId: 84532,
      expiryAt: '2026-12-31T23:59:59Z',
    }, buyer)

    expect(res.status).toBe(404)
  })

  it('GET /v2/channels/:address — returns channel', async () => {
    await authedRequest('POST', '/v2/channels', {
      channelAddress: '0x' + 'ef'.repeat(20),
      counterparty: seller.publicKey,
      depositAmount: 500,
      chainId: 84532,
      expiryAt: '2026-12-31T23:59:59Z',
    }, buyer)

    const res = await authedRequest('GET', '/v2/channels/0x' + 'ef'.repeat(20), null, buyer)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.depositAmount).toBe(500)
  })

  it('GET /v2/channels/:address — non-party gets 403', async () => {
    const thirdParty = generateKeypair()
    const thirdPartyId = crypto.randomUUID()
    mockDb.seedTable('agents', [
      ...mockDb.getTable('agents').rows,
      { id: thirdPartyId, public_key: thirdParty.publicKey, name: 'third', capabilities: [], metadata: {}, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), stripe_customer_id: null, stripe_connected_account_id: null, stripe_onboarding_complete: false, stripe_default_payment_method: null },
    ])

    await authedRequest('POST', '/v2/channels', {
      channelAddress: '0x' + 'aa'.repeat(20),
      counterparty: seller.publicKey,
      depositAmount: 500,
      chainId: 84532,
      expiryAt: '2026-12-31T23:59:59Z',
    }, buyer)

    const res = await authedRequest('GET', '/v2/channels/0x' + 'aa'.repeat(20), null, thirdParty)
    expect(res.status).toBe(403)
  })

  it('POST /v2/channels/:address/close — closes channel', async () => {
    await authedRequest('POST', '/v2/channels', {
      channelAddress: '0x' + 'bb'.repeat(20),
      counterparty: seller.publicKey,
      depositAmount: 500,
      chainId: 84532,
      expiryAt: '2026-12-31T23:59:59Z',
    }, buyer)

    const res = await authedRequest('POST', '/v2/channels/0x' + 'bb'.repeat(20) + '/close', {}, buyer)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.status).toBe('closed')
  })

  it('POST /v2/channels/:address/close — double close returns 409', async () => {
    await authedRequest('POST', '/v2/channels', {
      channelAddress: '0x' + 'cc'.repeat(20),
      counterparty: seller.publicKey,
      depositAmount: 500,
      chainId: 84532,
      expiryAt: '2026-12-31T23:59:59Z',
    }, buyer)

    await authedRequest('POST', '/v2/channels/0x' + 'cc'.repeat(20) + '/close', {}, buyer)
    const res = await authedRequest('POST', '/v2/channels/0x' + 'cc'.repeat(20) + '/close', {}, buyer)
    expect(res.status).toBe(409)
  })
})
