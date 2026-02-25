import { Hono } from 'hono'
import type { Env } from '../index'

export const reviews = new Hono<{ Bindings: Env }>()

// POST /v1/reviews — submit a verified review (receipt required)
reviews.post('/', async (c) => {
  const body = await c.req.json<{
    agentId: string
    rating: number
    comment?: string
    receipt: { type: 'stripe' | 'lightning' | 'eth' | 'solana'; id: string }
  }>()

  if (!body.agentId || !body.rating || !body.receipt) {
    return c.json({ success: false, error: 'agentId, rating, and receipt are required', code: 'INVALID_PARAMS' }, 400)
  }

  if (body.rating < 1 || body.rating > 5) {
    return c.json({ success: false, error: 'rating must be 1–5', code: 'INVALID_PARAMS' }, 400)
  }

  // TODO:
  // 1. Validate reviewer auth (X-Agent-Secret or X-Agent-Signature)
  // 2. Verify self-review not attempted
  // 3. Verify receipt against rail API (Stripe / chain / Alby)
  // 4. Check receipt_hash uniqueness (prevent double-count)
  // 5. Run fraud signals: review:volume ratio, counterparty diversity
  // 6. Insert transaction + review rows
  // 7. Emit score_events for reviewed agent
  // 8. Invalidate KV cache

  return c.json({ success: true, data: { reviewId: 'TODO', pointsAwarded: 0 } }, 201)
})
