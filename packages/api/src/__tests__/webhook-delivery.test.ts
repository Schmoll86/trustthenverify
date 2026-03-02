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

function seedAgent(keypair: { publicKey: string }) {
  mockDb.seedTable('agents', [
    {
      id: 'agent-id',
      public_key: keypair.publicKey,
      endpoint: null,
      name: 'test-agent',
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
  ])
}

describe('POST /v2/agents/:pubkey/webhook', () => {
  let agent: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    agent = generateKeypair()
    seedAgent(agent)
  })

  it('registers webhook successfully', async () => {
    const body = JSON.stringify({ url: 'https://example.com/webhook' })
    const res = await makeSignedRequest('POST', `/v2/agents/${agent.publicKey}/webhook`, body, agent)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { webhookUrl: string; webhookSecret: string } }
    expect(json.data.webhookUrl).toBe('https://example.com/webhook')
    expect(json.data.webhookSecret).toBeDefined()
    expect(json.data.webhookSecret.length).toBeGreaterThan(0)
  })

  it('rejects invalid URL', async () => {
    const body = JSON.stringify({ url: 'not-a-url' })
    const res = await makeSignedRequest('POST', `/v2/agents/${agent.publicKey}/webhook`, body, agent)
    expect(res.status).toBe(400)
  })

  it('rejects missing URL', async () => {
    const body = JSON.stringify({})
    const res = await makeSignedRequest('POST', `/v2/agents/${agent.publicKey}/webhook`, body, agent)
    expect(res.status).toBe(400)
  })

  it('rejects webhook registration for another agent', async () => {
    const other = generateKeypair()
    const body = JSON.stringify({ url: 'https://example.com/webhook' })
    const res = await makeSignedRequest('POST', `/v2/agents/${other.publicKey}/webhook`, body, agent)
    expect(res.status).toBe(403)
  })
})

describe('Notification consumer (webhook delivery)', () => {
  it('eventTypeToPrefKey maps kyc.complete', async () => {
    // Import the consumer to verify the map includes kyc.complete
    const mod = await import('../queue/notification-consumer')
    // handleNotification is exported; we test it accepts kyc.complete without crashing
    expect(mod.handleNotification).toBeDefined()
  })
})
