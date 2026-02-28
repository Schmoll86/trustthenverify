/**
 * Stripe webhook handler.
 * Mounted at /webhooks (outside /v2 auth middleware).
 * Authenticates via Stripe-Signature HMAC-SHA256.
 */

import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'

type AppEnv = {
  Bindings: Env
  Variables: Record<string, never>
}

export const webhooks = new Hono<AppEnv>()

// ── Stripe signature verification (Workers-compatible) ─────────────────────

const TIMESTAMP_TOLERANCE_SECONDS = 300 // 5 minutes

/**
 * Verify Stripe webhook signature using crypto.subtle HMAC-SHA256.
 * Uses double-HMAC pattern for constant-time comparison (Workers lacks timingSafeEqual).
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  // Parse t= and v1= from Stripe-Signature header
  const parts = signatureHeader.split(',')
  let timestamp: string | null = null
  let signature: string | null = null

  for (const part of parts) {
    const [key, value] = part.trim().split('=', 2)
    if (key === 't') timestamp = value
    if (key === 'v1') signature = value
  }

  if (!timestamp || !signature) return false

  // Check timestamp freshness (replay protection)
  const ts = parseInt(timestamp, 10)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > TIMESTAMP_TOLERANCE_SECONDS) return false

  // Compute expected signature: HMAC-SHA256(secret, "timestamp.rawBody")
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signedPayload = `${timestamp}.${rawBody}`
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload))
  const expectedHex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  // Constant-time compare via double-HMAC
  const comparisonKey = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const mac1 = await crypto.subtle.sign('HMAC', comparisonKey, new TextEncoder().encode(expectedHex))
  const mac2 = await crypto.subtle.sign('HMAC', comparisonKey, new TextEncoder().encode(signature))

  const arr1 = new Uint8Array(mac1)
  const arr2 = new Uint8Array(mac2)

  if (arr1.length !== arr2.length) return false
  let diff = 0
  for (let i = 0; i < arr1.length; i++) {
    diff |= arr1[i] ^ arr2[i]
  }
  return diff === 0
}

// ── POST /stripe ───────────────────────────────────────────────────────────

webhooks.post('/stripe', async (c) => {
  const signatureHeader = c.req.header('Stripe-Signature')
  if (!signatureHeader) {
    return c.json({ error: 'Missing Stripe-Signature header' }, 400)
  }

  const secret = c.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured')
    return c.json({ error: 'Webhook not configured' }, 500)
  }

  const rawBody = await c.req.text()

  const valid = await verifyStripeSignature(rawBody, signatureHeader, secret)
  if (!valid) {
    return c.json({ error: 'Invalid signature' }, 401)
  }

  let event: { type: string; data: { object: Record<string, unknown> } }
  try {
    event = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const db = createDb(c.env)

  switch (event.type) {
    case 'payment_intent.payment_failed': {
      const pi = event.data.object
      const escrowId = (pi.metadata as Record<string, string> | undefined)?.escrow_id
      if (escrowId) {
        await db
          .from('escrows')
          .update({ status: 'failed', completed_at: new Date().toISOString() })
          .eq('id', escrowId)
      }
      break
    }

    case 'account.updated': {
      const account = event.data.object
      const accountId = account.id as string
      const chargesEnabled = account.charges_enabled as boolean

      // Find agent with this connected account and update onboarding status
      const { data: agent } = await db
        .from('agents')
        .select('id')
        .eq('stripe_connected_account_id', accountId)
        .single()

      if (agent) {
        await db
          .from('agents')
          .update({ stripe_onboarding_complete: chargesEnabled })
          .eq('id', (agent as { id: string }).id)
      }
      break
    }

    default:
      // Acknowledge unknown events without processing
      break
  }

  return c.json({ received: true }, 200)
})
