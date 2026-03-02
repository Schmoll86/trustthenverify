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
    createSetupIntent = mockStripe.createSetupIntent
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

function seedAgent(keypair: { publicKey: string }, overrides: Record<string, unknown> = {}) {
  const agent = {
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
    ...overrides,
  }
  mockDb.seedTable('agents', [agent])
  return agent
}

describe('POST /v2/agents/:pubkey/stripe/customer', () => {
  let kp: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    kp = generateKeypair()
  })

  it('creates Stripe Customer for agent', async () => {
    seedAgent(kp)

    const res = await makeSignedRequest('POST', `/v2/agents/${kp.publicKey}/stripe/customer`, '{}', kp)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { stripeCustomerId: string } }
    expect(json.data.stripeCustomerId).toBeTruthy()
    expect(mockStripe.calls).toHaveLength(1)
    expect(mockStripe.calls[0].method).toBe('createCustomer')
  })

  it('rejects if already has customer', async () => {
    seedAgent(kp, { stripe_customer_id: 'cus_existing' })

    const res = await makeSignedRequest('POST', `/v2/agents/${kp.publicKey}/stripe/customer`, '{}', kp)
    expect(res.status).toBe(409)
  })

  it('rejects if different agent', async () => {
    seedAgent(kp)
    const other = generateKeypair()
    mockDb.getTable('agents').rows.push({
      id: 'other-id',
      public_key: other.publicKey,
      endpoint: null,
      name: 'other',
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

    // other tries to set up customer for kp
    const res = await makeSignedRequest('POST', `/v2/agents/${kp.publicKey}/stripe/customer`, '{}', other)
    expect(res.status).toBe(403)
  })
})

describe('POST /v2/agents/:pubkey/stripe/connect', () => {
  let kp: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    kp = generateKeypair()
  })

  it('creates Express account and returns onboarding URL', async () => {
    seedAgent(kp)

    const res = await makeSignedRequest('POST', `/v2/agents/${kp.publicKey}/stripe/connect`, '{}', kp)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { agent: { stripeConnectedAccountId: string }; onboardingUrl: string } }
    expect(json.data.agent.stripeConnectedAccountId).toBeTruthy()
    expect(json.data.onboardingUrl).toContain('stripe.com')
    expect(mockStripe.calls).toHaveLength(1)
    expect(mockStripe.calls[0].method).toBe('createConnectAccount')
  })

  it('rejects if already has connect account', async () => {
    seedAgent(kp, { stripe_connected_account_id: 'acct_existing' })

    const res = await makeSignedRequest('POST', `/v2/agents/${kp.publicKey}/stripe/connect`, '{}', kp)
    expect(res.status).toBe(409)
  })
})

describe('GET /v2/agents/:pubkey/stripe/status', () => {
  let kp: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    kp = generateKeypair()
  })

  it('returns status for agent with connect account', async () => {
    seedAgent(kp, { stripe_connected_account_id: 'acct_test', stripe_customer_id: 'cus_test' })

    // GET doesn't require body signing — use signed GET
    const res = await makeSignedRequest('GET', `/v2/agents/${kp.publicKey}/stripe/status`, '', kp)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { hasCustomer: boolean; hasConnectAccount: boolean; onboardingComplete: boolean } }
    expect(json.data.hasCustomer).toBe(true)
    expect(json.data.hasConnectAccount).toBe(true)
    expect(json.data.onboardingComplete).toBe(true) // mock returns chargesEnabled + payoutsEnabled = true
  })

  it('returns empty status for agent without Stripe', async () => {
    seedAgent(kp)

    const res = await makeSignedRequest('GET', `/v2/agents/${kp.publicKey}/stripe/status`, '', kp)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { hasCustomer: boolean; hasConnectAccount: boolean } }
    expect(json.data.hasCustomer).toBe(false)
    expect(json.data.hasConnectAccount).toBe(false)
  })
})

describe('POST /v2/agents/:pubkey/stripe/setup-intent', () => {
  let kp: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    kp = generateKeypair()
  })

  it('creates SetupIntent for agent with customer', async () => {
    seedAgent(kp, { stripe_customer_id: 'cus_test' })

    const res = await makeSignedRequest('POST', `/v2/agents/${kp.publicKey}/stripe/setup-intent`, '{}', kp)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { setupIntentId: string; clientSecret: string } }
    expect(json.data.setupIntentId).toBeTruthy()
    expect(json.data.clientSecret).toBeTruthy()
    expect(mockStripe.calls).toHaveLength(1)
    expect(mockStripe.calls[0].method).toBe('createSetupIntent')
  })

  it('rejects if no customer exists', async () => {
    seedAgent(kp)

    const res = await makeSignedRequest('POST', `/v2/agents/${kp.publicKey}/stripe/setup-intent`, '{}', kp)
    expect(res.status).toBe(400)
  })

  it('rejects if different agent', async () => {
    seedAgent(kp, { stripe_customer_id: 'cus_test' })
    const other = generateKeypair()
    mockDb.getTable('agents').rows.push({
      id: 'other-id',
      public_key: other.publicKey,
      endpoint: null,
      name: 'other',
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

    const res = await makeSignedRequest('POST', `/v2/agents/${kp.publicKey}/stripe/setup-intent`, '{}', other)
    expect(res.status).toBe(403)
  })
})

describe('POST /v2/agents/:pubkey/stripe/payment-method', () => {
  let kp: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    kp = generateKeypair()
  })

  it('attaches payment method to customer', async () => {
    seedAgent(kp, { stripe_customer_id: 'cus_test' })

    const body = JSON.stringify({ paymentMethodId: 'pm_test_123' })
    const res = await makeSignedRequest('POST', `/v2/agents/${kp.publicKey}/stripe/payment-method`, body, kp)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { stripeDefaultPaymentMethod: string } }
    expect(json.data.stripeDefaultPaymentMethod).toBe('pm_test_123')
    expect(mockStripe.calls).toHaveLength(1)
    expect(mockStripe.calls[0].method).toBe('attachPaymentMethod')
  })

  it('rejects if no customer exists', async () => {
    seedAgent(kp)

    const body = JSON.stringify({ paymentMethodId: 'pm_test_123' })
    const res = await makeSignedRequest('POST', `/v2/agents/${kp.publicKey}/stripe/payment-method`, body, kp)
    expect(res.status).toBe(400)
  })

  it('rejects if paymentMethodId missing', async () => {
    seedAgent(kp, { stripe_customer_id: 'cus_test' })

    const res = await makeSignedRequest('POST', `/v2/agents/${kp.publicKey}/stripe/payment-method`, '{}', kp)
    expect(res.status).toBe(400)
  })
})
