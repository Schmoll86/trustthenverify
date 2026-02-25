import { Hono } from 'hono'
import type { Env } from './lib/db'
import { authMiddleware } from './middleware/auth'
import { agents } from './routes/agents'
import { policies } from './routes/policies'
import { escrow } from './routes/escrow'
import { verify } from './routes/verify'
import { attestations } from './routes/attestations'
import { disputes } from './routes/disputes'
import { handleEscrowTimeout } from './cron/escrow-timeout'
import { handleArgusMessage, type ArgusQueueMessage } from './queue/argus-consumer'

type AppEnv = {
  Bindings: Env
  Variables: {
    agentPubkey?: string
    agentId?: string
    sandboxMode?: boolean
    rawBody?: string
  }
}

const app = new Hono<AppEnv>()

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/', (c) => c.json({ name: 'TrustThenVerify API', version: '2.0.0', spec: 'SPEC-v2' }))

// ── Auth middleware (applies to all /v2 routes) ──────────────────────────────
app.use('/v2/*', authMiddleware)

// ── Route groups (§9.3) ──────────────────────────────────────────────────────
app.route('/v2/agents', agents)
app.route('/v2/policies', policies)
app.route('/v2/escrow', escrow)
app.route('/v2/verify', verify)
app.route('/v2/attestations', attestations)
app.route('/v2/disputes', disputes)

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env) {
    await handleEscrowTimeout(env)
  },
  async queue(batch: MessageBatch<ArgusQueueMessage>, env: Env) {
    for (const msg of batch.messages) {
      try {
        if (msg.body.type === 'argus_refine') {
          await handleArgusMessage(msg.body, env)
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
