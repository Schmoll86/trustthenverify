import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { createMockDb, type MockDb } from './helpers/mock-db'

let mockDb: MockDb

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

const WEBHOOK_SECRET = 'whsec_test_edge_secret'

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

describe('POST /webhooks/stripe — edge cases', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('payment_intent.payment_failed with no metadata.escrow_id is a no-op', async () => {
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
          id: 'pi_no_metadata',
          metadata: {},  // No escrow_id
        },
      },
    })

    const sig = await signWebhookPayload(body, WEBHOOK_SECRET)
    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
      body,
    }, env)

    expect(res.status).toBe(200)
    // Escrow should remain unchanged
    const escrow = mockDb.getTable('escrows').rows[0]
    expect(escrow.status).toBe('active')
  })

  it('payment_intent.payment_failed with nonexistent escrow_id does not error', async () => {
    mockDb.seedTable('escrows', [])

    const body = JSON.stringify({
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_test',
          metadata: { escrow_id: 'nonexistent-escrow' },
        },
      },
    })

    const sig = await signWebhookPayload(body, WEBHOOK_SECRET)
    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
      body,
    }, env)

    // Should still return 200 — update is a no-op on nonexistent row
    expect(res.status).toBe(200)
    const json = await res.json() as { received: boolean }
    expect(json.received).toBe(true)
  })

  it('account.updated with unknown account_id is a no-op', async () => {
    mockDb.seedTable('agents', [{
      id: 'agent-1',
      public_key: 'pk_test',
      stripe_connected_account_id: 'acct_known',
      stripe_onboarding_complete: false,
    }])

    const body = JSON.stringify({
      type: 'account.updated',
      data: {
        object: {
          id: 'acct_unknown', // No matching agent
          charges_enabled: true,
        },
      },
    })

    const sig = await signWebhookPayload(body, WEBHOOK_SECRET)
    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
      body,
    }, env)

    expect(res.status).toBe(200)
    // Agent should remain unchanged
    const agent = mockDb.getTable('agents').rows[0]
    expect(agent.stripe_onboarding_complete).toBe(false)
  })

  it('account.updated sets onboarding_complete=false when charges_enabled=false', async () => {
    mockDb.seedTable('agents', [{
      id: 'agent-1',
      public_key: 'pk_test',
      stripe_connected_account_id: 'acct_123',
      stripe_onboarding_complete: true, // Currently true
    }])

    const body = JSON.stringify({
      type: 'account.updated',
      data: {
        object: {
          id: 'acct_123',
          charges_enabled: false, // Revoked
        },
      },
    })

    const sig = await signWebhookPayload(body, WEBHOOK_SECRET)
    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
      body,
    }, env)

    expect(res.status).toBe(200)
    const agent = mockDb.getTable('agents').rows[0]
    expect(agent.stripe_onboarding_complete).toBe(false)
  })

  it('returns 500 when STRIPE_WEBHOOK_SECRET is not configured', async () => {
    const body = JSON.stringify({ type: 'test' })
    const sig = await signWebhookPayload(body, WEBHOOK_SECRET)

    const envNoSecret = { ...env, STRIPE_WEBHOOK_SECRET: undefined } as unknown as Record<string, string>
    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
      body,
    }, envNoSecret)

    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).toContain('not configured')
  })

  it('returns 400 when body is not valid JSON after valid signature', async () => {
    const invalidBody = 'not-json-{{'
    const sig = await signWebhookPayload(invalidBody, WEBHOOK_SECRET)

    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig },
      body: invalidBody,
    }, env)

    expect(res.status).toBe(400)
    const json = await res.json() as { error: string }
    expect(json.error).toContain('Invalid JSON')
  })
})
