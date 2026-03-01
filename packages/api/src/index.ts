import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './lib/db'
import { loggingMiddleware, errorHandler } from './middleware/logging'
import { authMiddleware } from './middleware/auth'
import { rateLimitMiddleware } from './middleware/rate-limit'
import { agents } from './routes/agents'
import { policies } from './routes/policies'
import { escrow } from './routes/escrow'
import { verify } from './routes/verify'
import { attestations } from './routes/attestations'
import { disputes } from './routes/disputes'
import { oracles } from './routes/oracles'
import { channels } from './routes/channels'
import { marketplace } from './routes/marketplace'
import { handleEscrowTimeout, handleOnchainFunding, handleOracleTimeout, handleAutoRefinement, handleOraclePayouts } from './cron/escrow-timeout'
import { webhooks } from './routes/webhooks'
import { handleArgusMessage, type ArgusQueueMessage } from './queue/argus-consumer'
import { handleOracleDispatch, type OracleQueueMessage } from './queue/oracle-consumer'
import { handleNotification, type NotificationQueueMessage } from './queue/notification-consumer'

type AppEnv = {
  Bindings: Env
  Variables: {
    agentPubkey?: string
    agentId?: string
    sandboxMode?: boolean
    rawBody?: string
    requestId?: string
  }
}

const app = new Hono<AppEnv>()

// ── Error boundary ───────────────────────────────────────────────────────────
app.onError(errorHandler)

// ── CORS (allow browser requests from landing page) ─────────────────────────
app.use('*', cors({
  origin: ['https://trustthenverify.com', 'https://www.trustthenverify.com', 'https://sandbox.trustthenverify.com'],
  allowHeaders: ['Content-Type', 'X-Agent-Pubkey', 'X-Agent-Timestamp', 'X-Agent-Signature', 'X-Sandbox-Key'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  maxAge: 86400,
}))

// ── Logging (outermost middleware) ───────────────────────────────────────────
app.use('*', loggingMiddleware)

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/', (c) => c.json({ name: 'TrustThenVerify API', version: '2.0.0', spec: 'SPEC-v2' }))
app.get('/v2/health', async (c) => {
  const checks: Record<string, string> = {}

  // DB connectivity check
  try {
    const { createDb } = await import('./lib/db')
    const db = createDb(c.env as unknown as Env)
    const { error } = await db.from('agents').select('id').limit(1)
    checks.db = error ? 'degraded' : 'ok'
  } catch {
    checks.db = 'down'
  }

  // Stripe connectivity check (use customers endpoint — works with restricted keys)
  try {
    const res = await fetch('https://api.stripe.com/v1/customers?limit=1', {
      headers: { 'Authorization': `Bearer ${(c.env as unknown as Env).STRIPE_SECRET_KEY}` },
    })
    checks.stripe = res.ok ? 'ok' : 'degraded'
  } catch {
    checks.stripe = 'down'
  }

  // KV check
  try {
    const kv = (c.env as unknown as Env).RATE_LIMIT_KV
    if (kv) {
      await kv.get('__health_check')
      checks.kv = 'ok'
    } else {
      checks.kv = 'unavailable'
    }
  } catch {
    checks.kv = 'down'
  }

  const allOk = Object.values(checks).every(v => v === 'ok' || v === 'unavailable')
  const anyDown = Object.values(checks).some(v => v === 'down')
  const status = anyDown ? 'down' : allOk ? 'ok' : 'degraded'

  return c.json({ status, version: '2.0.0', checks })
})

// ── Webhooks (before auth — authenticates via Stripe signature) ──────────
app.route('/webhooks', webhooks)

// ── Auth middleware (applies to all /v2 routes) ──────────────────────────────
app.use('/v2/*', authMiddleware)

// ── Rate limiting (after auth, needs agentId) ────────────────────────────────
app.use('/v2/*', rateLimitMiddleware)

// ── Route groups (§9.3) ──────────────────────────────────────────────────────
app.route('/v2/agents', agents)
app.route('/v2/policies', policies)
app.route('/v2/escrow', escrow)
app.route('/v2/verify', verify)
app.route('/v2/attestations', attestations)
app.route('/v2/disputes', disputes)
app.route('/v2/oracles', oracles)
app.route('/v2/channels', channels)
app.route('/v2/marketplace', marketplace)

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env) {
    await handleEscrowTimeout(env)
    await handleOnchainFunding(env)
    await handleOracleTimeout(env)
    await handleAutoRefinement(env)
    await handleOraclePayouts(env)
  },
  async queue(batch: MessageBatch<ArgusQueueMessage | OracleQueueMessage | NotificationQueueMessage>, env: Env) {
    for (const msg of batch.messages) {
      try {
        if (msg.body.type === 'argus_refine') {
          await handleArgusMessage(msg.body as ArgusQueueMessage, env)
        } else if (msg.body.type === 'oracle_dispatch') {
          await handleOracleDispatch(msg.body as OracleQueueMessage, env)
        } else if (msg.body.type === 'notification') {
          await handleNotification(msg.body as NotificationQueueMessage, env)
        }
        msg.ack()
      } catch {
        msg.retry()
      }
    }
  },
}

// Also export the app directly for test usage (app.request())
export { app }
