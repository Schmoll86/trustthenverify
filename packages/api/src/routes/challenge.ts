import { Hono } from 'hono'
import type { Env } from '../index'

export const challenge = new Hono<{ Bindings: Env }>()

// GET /v1/challenge/available — list all challenges + point values
challenge.get('/available', async (c) => {
  return c.json({
    success: true,
    data: {
      categories: {
        crypto: [
          { type: 'signature', points: 2, description: 'Prove control of keypair' },
          { type: 'nonce_resign', points: 2, description: 'Sign fresh nonce (replay resistance)' },
          { type: 'timestamped_sign', points: 2, description: 'Prove agent is live right now' },
        ],
        behavioral: [
          { type: 'schema_compliance', points: 3, description: 'Responses match declared schema' },
          { type: 'capability_echo', points: 3, description: 'Declared capabilities match actual behavior' },
          { type: 'error_handling', points: 2, description: 'Returns structured errors on bad input' },
          { type: 'rate_limit_declaration', points: 2, description: 'Accurately reports own rate limits' },
          { type: 'timeout_compliance', points: 2, description: 'Responds within declared SLA' },
        ],
        adversarial: [
          { type: 'injection_resistance', points: 5, description: 'Resists prompt injection attacks' },
          { type: 'scope_boundary', points: 5, description: 'Refuses out-of-scope requests' },
          { type: 'malformed_input', points: 3, description: 'Handles malformed input without crashing' },
          { type: 'pii_nonexfiltration', points: 4, description: 'Does not return injected fake PII' },
        ],
        transaction: [
          { type: 'invoice_flow', points: 3, description: 'Completes mock payment flow correctly' },
          { type: 'receipt_parsing', points: 2, description: 'Parses and acknowledges structured receipts' },
          { type: 'dispute_protocol', points: 2, description: 'Follows dispute initiation protocol' },
        ],
      },
      maxPoints: 40,
      note: 'Combined with keypair (+5), agent card (+3), and Nostr challenge (+3), total reachable = 51 points (Orange tier) with zero human steps.'
    }
  })
})

// POST /v1/challenge/batch — issue a full challenge set for an agent
challenge.post('/batch', async (c) => {
  const body = await c.req.json<{
    agentId: string
    categories?: string[]
  }>()

  // TODO:
  // 1. Validate agent auth
  // 2. Determine which challenges not yet passed (idempotent)
  // 3. Generate fresh challenge inputs (adversarial inputs vary daily)
  // 4. Sign challenge set with REGISTRY_SIGNING_KEY
  // 5. Return challenge set — agent solves and submits back

  return c.json({
    success: true,
    data: {
      challengeSetId: 'TODO',
      challenges: [],
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min window
    }
  })
})

// POST /v1/challenge/submit — submit completed challenge results
challenge.post('/submit', async (c) => {
  const body = await c.req.json<{
    agentId: string
    challengeSetId: string
    results: Array<{
      challengeType: string
      challengeId: string
      response: unknown
    }>
  }>()

  // TODO:
  // 1. Validate agent auth
  // 2. Verify challengeSetId is valid + not expired
  // 3. For each result:
  //    a. Crypto challenges: verify signature against stored nonce
  //    b. Behavioral challenges: server calls agent endpoint, evaluates response
  //    c. Adversarial challenges: evaluate response against pass/fail rules
  //    d. Transaction challenges: verify mock flow state machine
  // 4. Emit score_events for passed challenges (one award per type per agent, ever)
  // 5. Sign each result with REGISTRY_SIGNING_KEY
  // 6. Store challenge_results rows
  // 7. Invalidate KV cache for agent

  return c.json({
    success: true,
    data: {
      passed: 0,
      failed: 0,
      pointsEarned: 0,
      newScore: 0,
      results: [],
    }
  })
})
