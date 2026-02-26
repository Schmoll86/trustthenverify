import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { snakeToCamel } from '../lib/case'
import { success, error } from '../lib/response'

type AppEnv = {
  Bindings: Env
  Variables: {
    agentPubkey?: string
    agentId?: string
    sandboxMode?: boolean
    rawBody?: string
  }
}

export const disputes = new Hono<AppEnv>()

// GET /disputes/:id — return dispute with ruling + rationale
disputes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const db = createDb(c.env)

  const { data: row } = await db
    .from('disputes')
    .select('*')
    .eq('id', id)
    .single()

  if (!row) {
    return error(c, 404, 'NOT_FOUND', `Dispute not found: ${id}`)
  }

  // Parse evidence_hash back into structured data if it contains JSON
  const dispute = snakeToCamel(row)
  if (typeof row.evidence_hash === 'string' && row.evidence_hash.startsWith('{')) {
    try {
      const parsed = JSON.parse(row.evidence_hash)
      ;(dispute as Record<string, unknown>).arbitrationDetails = parsed
    } catch {
      // Keep as-is
    }
  }

  return success(c, dispute)
})

// POST /disputes/:id/ruling — 403 (system-only, no manual override)
disputes.post('/:id/ruling', async (c) => {
  return error(c, 403, 'FORBIDDEN', 'Manual ruling override is not permitted. Arbitration is automated.')
})
