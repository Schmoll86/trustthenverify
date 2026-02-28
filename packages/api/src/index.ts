import { Hono } from 'hono'
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

// ── Logging (outermost middleware) ───────────────────────────────────────────
app.use('*', loggingMiddleware)

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/', (c) => c.json({ name: 'TrustThenVerify API', version: '2.0.0', spec: 'SPEC-v2' }))
app.get('/v2/health', (c) => c.json({ status: 'ok', version: '2.0.0' }))

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
  async queue(batch: MessageBatch<ArgusQueueMessage | OracleQueueMessage>, env: Env) {
    for (const msg of batch.messages) {
      try {
        if (msg.body.type === 'argus_refine') {
          await handleArgusMessage(msg.body as ArgusQueueMessage, env)
        } else if (msg.body.type === 'oracle_dispatch') {
          await handleOracleDispatch(msg.body as OracleQueueMessage, env)
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
