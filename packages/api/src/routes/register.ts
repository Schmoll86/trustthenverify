import { Hono } from 'hono'
import type { Env } from '../index'

export const register = new Hono<{ Bindings: Env }>()

// POST /v1/register — create a new agent
register.post('/', async (c) => {
  const body = await c.req.json<{
    name: string
    contact: string
    generateKeypair?: boolean
    endpoint?: string
    operatorId?: string
    operatorSecret?: string
  }>()

  if (!body.name || !body.contact) {
    return c.json({ success: false, error: 'name and contact are required', code: 'INVALID_PARAMS' }, 400)
  }

  // TODO:
  // 1. Validate operator credentials if operatorId provided
  // 2. Generate UUID + secret
  // 3. Generate secp256k1 keypair if generateKeypair: true
  // 4. Insert into agents table
  // 5. If operator: compute bootstrapped_score, emit operator_inherited score_events
  // 6. Invalidate KV cache (nothing to invalidate yet, but set up the pattern)
  // 7. Return credentials — privateKey returned once, never again

  return c.json({
    success: true,
    data: {
      agentId: 'TODO',
      secret: 'TODO',
      publicKey: body.generateKeypair ? 'TODO' : null,
      privateKey: body.generateKeypair ? 'TODO — store this, never sent again' : null,
      initialScore: 0,
      nextSteps: [
        { action: 'challenges', description: 'Run autonomous trust challenges to reach Orange tier in ~5 minutes', points: 38 },
        { action: 'dns', description: 'Add DNS TXT record for domain verification', points: 5 },
        { action: 'transaction', description: 'Complete a real Stripe transaction', points: 5 },
      ]
    }
  }, 201)
})
