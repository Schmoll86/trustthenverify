import { Hono } from 'hono'
import type { Env } from '../index'

export const payment = new Hono<{ Bindings: Env }>()

// POST /v1/payment/request — create Lightning invoice via payee's NWC
payment.post('/request', async (c) => {
  const body = await c.req.json<{
    payeeAgentId: string
    amountSats: number
    contextId?: string
  }>()

  // TODO:
  // 1. Validate payer auth
  // 2. Look up payee's NWC connection string (from verifications table)
  // 3. Call payee's Alby NWC to generate invoice
  // 4. Store (payment_hash, payee_id, payer_id, amount, context_id, expires_at)
  // 5. Return BOLT11 invoice string

  return c.json({
    success: true,
    data: {
      paymentId: 'TODO',
      bolt11: 'TODO',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }
  })
})

// GET /v1/payment/:id — check Lightning payment settlement status
payment.get('/:id', async (c) => {
  const paymentId = c.req.param('id')

  // TODO:
  // 1. Look up payment record
  // 2. If not settled: poll Alby API for settlement
  // 3. If settled: verify SHA256(preimage) === stored payment_hash
  // 4. If verified: record transaction, emit score_events, invalidate KV

  return c.json({
    success: true,
    data: {
      paymentId,
      settled: false,
      preimageVerified: false,
      transactionId: null,
    }
  })
})
