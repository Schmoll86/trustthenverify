import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { verifyStripeSignature } from '../routes/webhooks'
import { createMockDb, type MockDb } from './helpers/mock-db'

let mockDb: MockDb

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

const WEBHOOK_SECRET = 'whsec_test_secret_123'

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'test-gateway-key',
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
}

/** Generate a valid Stripe-Signature header for a given body. */
async function signWebhookPayload(body: string, secret: string, timestamp?: number): Promise<string> {
  const ts = timestamp ?? Math.floor(Date.now() / 1000)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`))
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `t=${ts},v1=${hex}`
}

describe('POST /webhooks/stripe', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('payment_intent.payment_failed updates escrow status', async () => {
    mockDb.seedTable('escrows', [{
      id: 'escrow-1',
      status: 'active',
      buyer_id: 'b1',
      seller_id: 's1',
      amount_cents: 5000,
    }])

    const body = JSON.stringify({
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_test_123',
          metadata: { escrow_id: 'escrow-1' },
        },
      },
    })

    const sig = await signWebhookPayload(body, WEBHOOK_SECRET)
    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': sig,
      },
      body,
    }, env)

    expect(res.status).toBe(200)
    const json = await res.json() as { received: boolean }
    expect(json.received).toBe(true)

    // Verify escrow was updated
    const escrow = mockDb.getTable('escrows').rows[0]
    expect(escrow.status).toBe('failed')
    expect(escrow.completed_at).toBeDefined()
  })

  it('account.updated updates agent onboarding flag', async () => {
    mockDb.seedTable('agents', [{
      id: 'agent-1',
      public_key: 'pk_test',
      stripe_connected_account_id: 'acct_123',
      stripe_onboarding_complete: false,
    }])

    const body = JSON.stringify({
      type: 'account.updated',
      data: {
        object: {
          id: 'acct_123',
          charges_enabled: true,
        },
      },
    })

    const sig = await signWebhookPayload(body, WEBHOOK_SECRET)
    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': sig,
      },
      body,
    }, env)

    expect(res.status).toBe(200)

    const agent = mockDb.getTable('agents').rows[0]
    expect(agent.stripe_onboarding_complete).toBe(true)
  })

  it('rejects missing Stripe-Signature header → 400', async () => {
    const body = JSON.stringify({ type: 'test' })
    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, env)

    expect(res.status).toBe(400)
  })

  it('rejects invalid signature → 401', async () => {
    const body = JSON.stringify({ type: 'test' })
    const sig = await signWebhookPayload(body, 'wrong_secret')

    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': sig,
      },
      body,
    }, env)

    expect(res.status).toBe(401)
  })

  it('rejects old timestamp (replay attack) → 401', async () => {
    const body = JSON.stringify({ type: 'test' })
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600 // 10 minutes ago
    const sig = await signWebhookPayload(body, WEBHOOK_SECRET, oldTimestamp)

    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': sig,
      },
      body,
    }, env)

    expect(res.status).toBe(401)
  })

  it('unknown event type → 200 (acknowledge, no-op)', async () => {
    const body = JSON.stringify({
      type: 'some.unknown.event',
      data: { object: {} },
    })

    const sig = await signWebhookPayload(body, WEBHOOK_SECRET)
    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': sig,
      },
      body,
    }, env)

    expect(res.status).toBe(200)
    const json = await res.json() as { received: boolean }
    expect(json.received).toBe(true)
  })
})

describe('verifyStripeSignature', () => {
  it('returns true for valid signature', async () => {
    const body = '{"test": true}'
    const ts = Math.floor(Date.now() / 1000)
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`))
    const hex = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    const result = await verifyStripeSignature(body, `t=${ts},v1=${hex}`, WEBHOOK_SECRET)
    expect(result).toBe(true)
  })

  it('returns false for tampered body', async () => {
    const body = '{"test": true}'
    const sig = await signWebhookPayload(body, WEBHOOK_SECRET)

    const result = await verifyStripeSignature('{"test": false}', sig, WEBHOOK_SECRET)
    expect(result).toBe(false)
  })

  it('returns false for missing t= or v1=', async () => {
    const result = await verifyStripeSignature('body', 'invalid_header', WEBHOOK_SECRET)
    expect(result).toBe(false)
  })
})
