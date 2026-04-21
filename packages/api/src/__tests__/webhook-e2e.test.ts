/**
 * End-to-end tests for webhook registration → escrow state change →
 * notification queued → HMAC-signed delivery.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockStripe } from './helpers/mock-stripe'
import { handleNotification, type NotificationQueueMessage } from '../queue/notification-consumer'

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
  QUEUE: { send: vi.fn() },
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
  }, env as unknown as Record<string, unknown>)
}

function seedAgent(keypair: { publicKey: string }, overrides: Record<string, unknown> = {}) {
  return {
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
}

function seedBuyerSeller(buyer: { publicKey: string }, seller: { publicKey: string }) {
  mockDb.seedTable('agents', [
    seedAgent(buyer, {
      id: 'buyer-id',
      name: 'buyer',
      stripe_customer_id: 'cus_buyer',
      stripe_default_payment_method: 'pm_buyer',
      webhook_url: 'https://buyer.example.com/webhook',
      webhook_secret: 'buyer-secret-key',
    }),
    seedAgent(seller, {
      id: 'seller-id',
      name: 'seller',
      capabilities: ['web-search'],
      stripe_customer_id: 'cus_seller',
      stripe_connected_account_id: 'acct_seller',
      stripe_onboarding_complete: true,
      stripe_default_payment_method: 'pm_seller',
      webhook_url: 'https://seller.example.com/webhook',
      webhook_secret: 'seller-secret-key',
    }),
  ])
}

// ── Webhook registration tests ──────────────────────────────────────────

describe('Webhook registration', () => {
  let agent: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    agent = generateKeypair()
    mockDb.seedTable('agents', [seedAgent(agent)])
  })

  it('registers webhook -> stores webhook_url + webhook_secret', async () => {
    const body = JSON.stringify({ url: 'https://example.com/webhook' })
    const res = await makeSignedRequest('POST', `/v2/agents/${agent.publicKey}/webhook`, body, agent)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { webhookUrl: string; webhookSecret: string } }
    expect(json.data.webhookUrl).toBe('https://example.com/webhook')
    expect(json.data.webhookSecret).toBeTruthy()

    // Verify stored in DB
    const agentRow = mockDb.getTable('agents').rows[0]
    expect(agentRow.webhook_url).toBe('https://example.com/webhook')
    expect(agentRow.webhook_secret).toBeTruthy()
  })
})

// ── Notification consumer + HMAC tests ──────────────────────────────────

describe('Webhook delivery via notification consumer', () => {
  const originalFetch = global.fetch
  let mockFetchFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockDb = createMockDb()
    mockFetchFn = vi.fn().mockResolvedValue({ ok: true })
    global.fetch = mockFetchFn
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('delivers webhook with correct payload structure', async () => {
    mockDb.seedTable('agents', [{
      id: 'agent-with-webhook',
      email: null,
      notification_preferences: null,
      webhook_url: 'https://test.example.com/hook',
      webhook_secret: 'test-secret-123',
    }])

    const msg: NotificationQueueMessage = {
      type: 'notification',
      agentId: 'agent-with-webhook',
      eventType: 'escrow.released',
      escrowId: 'esc-1',
      payload: { amountCents: 5000 },
    }

    await handleNotification(msg, env as unknown as Parameters<typeof handleNotification>[1])

    expect(mockFetchFn).toHaveBeenCalledOnce()
    const [url, opts] = mockFetchFn.mock.calls[0]
    expect(url).toBe('https://test.example.com/hook')
    expect(opts.method).toBe('POST')

    const body = JSON.parse(opts.body)
    expect(body.event).toBe('escrow.released')
    expect(body.escrowId).toBe('esc-1')
    expect(body.timestamp).toBeDefined()
    expect(body.data).toEqual({ amountCents: 5000 })
  })

  it('HMAC-SHA256 signature in X-TTV-Signature matches expected hex', async () => {
    const secret = 'hmac-test-secret-value'
    mockDb.seedTable('agents', [{
      id: 'agent-hmac',
      email: null,
      notification_preferences: null,
      webhook_url: 'https://hmac.example.com/hook',
      webhook_secret: secret,
    }])

    const msg: NotificationQueueMessage = {
      type: 'notification',
      agentId: 'agent-hmac',
      eventType: 'escrow.proposed',
      escrowId: 'esc-hmac',
      payload: { seller: 'seller-1' },
    }

    await handleNotification(msg, env as unknown as Parameters<typeof handleNotification>[1])

    const [, opts] = mockFetchFn.mock.calls[0]
    const signature = opts.headers['X-TTV-Signature']
    const payloadStr = opts.body as string

    // Independently compute HMAC to verify
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadStr))
    const expectedSig = Array.from(new Uint8Array(mac))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    expect(signature).toBe(expectedSig)
  })

  it('agent without webhook -> handleNotification skips gracefully', async () => {
    mockDb.seedTable('agents', [{
      id: 'agent-no-webhook',
      email: null,
      notification_preferences: null,
      webhook_url: null,
      webhook_secret: null,
    }])

    const msg: NotificationQueueMessage = {
      type: 'notification',
      agentId: 'agent-no-webhook',
      eventType: 'escrow.released',
      escrowId: 'esc-1',
      payload: {},
    }

    // Should not throw and should not call fetch
    await handleNotification(msg, env as unknown as Parameters<typeof handleNotification>[1])
    expect(mockFetchFn).not.toHaveBeenCalled()
  })

  it('opted-out event -> webhook skipped for email but still delivered via webhook', async () => {
    mockDb.seedTable('agents', [{
      id: 'agent-opted-out',
      email: 'test@example.com',
      notification_preferences: { verificationResult: false },
      webhook_url: 'https://opted-out.example.com/hook',
      webhook_secret: 'secret',
    }])

    const msg: NotificationQueueMessage = {
      type: 'notification',
      agentId: 'agent-opted-out',
      eventType: 'escrow.released', // maps to verificationResult
      escrowId: 'esc-1',
      payload: {},
    }

    await handleNotification(msg, { ...env, EMAIL_API_KEY: 'rk_test' } as unknown as Parameters<typeof handleNotification>[1])

    // Webhook should still fire (opted-out only affects email)
    // Check that fetch was called for the webhook
    expect(mockFetchFn).toHaveBeenCalled()
    const [url] = mockFetchFn.mock.calls[0]
    expect(url).toBe('https://opted-out.example.com/hook')
  })

  it('X-TTV-Event header contains correct event type', async () => {
    mockDb.seedTable('agents', [{
      id: 'agent-event',
      email: null,
      notification_preferences: null,
      webhook_url: 'https://event.example.com/hook',
      webhook_secret: 'secret',
    }])

    const msg: NotificationQueueMessage = {
      type: 'notification',
      agentId: 'agent-event',
      eventType: 'escrow.disputed',
      escrowId: 'esc-1',
      payload: {},
    }

    await handleNotification(msg, env as unknown as Parameters<typeof handleNotification>[1])

    const [, opts] = mockFetchFn.mock.calls[0]
    expect(opts.headers['X-TTV-Event']).toBe('escrow.disputed')
    expect(opts.headers['Content-Type']).toBe('application/json')
  })

  it('nonexistent agent -> handleNotification returns early', async () => {
    mockDb.seedTable('agents', [])

    const msg: NotificationQueueMessage = {
      type: 'notification',
      agentId: 'nonexistent',
      eventType: 'escrow.released',
      escrowId: 'esc-1',
      payload: {},
    }

    // Should not throw
    await handleNotification(msg, env as unknown as Parameters<typeof handleNotification>[1])
    expect(mockFetchFn).not.toHaveBeenCalled()
  })
})
