import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { snakeToCamel } from '../lib/case'
import { error } from '../lib/response'
import type { Policy } from '@trustthenverify/sdk'

type AppEnv = {
  Bindings: Env
  Variables: {
    agentPubkey?: string
    agentId?: string
    sandboxMode?: boolean
    rawBody?: string
  }
}

export const policies = new Hono<AppEnv>()

// GET /policies/templates — browse pre-refined policy templates
policies.get('/templates', async (c) => {
  const db = createDb(c.env)

  const { data: rows, error: dbError } = await db
    .from('policies')
    .select('*')
    .eq('status', 'active')
    .eq('billing', 'platform')
    .order('name', { ascending: true })

  if (dbError) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fetch policy templates')
  }

  const templates = (rows || []).map((r: Record<string, unknown>) => snakeToCamel<Policy>(r))

  return c.json({
    data: templates,
    meta: {
      requestId: crypto.randomUUID(),
      count: templates.length,
    },
  })
})

// POST /policies — create policy (Phase 2)
policies.post('/', async (c) => c.json({ error: 'not implemented' }, 501))

// GET /policies/:id — get policy with formal spec + coverage map
policies.get('/:id', async (c) => c.json({ error: 'not implemented' }, 501))

// POST /policies/:id/revise
policies.post('/:id/revise', async (c) => c.json({ error: 'not implemented' }, 501))

// POST /policies/:id/activate
policies.post('/:id/activate', async (c) => c.json({ error: 'not implemented' }, 501))

// POST /policies/:id/refine — trigger Argus Codex (Phase 3)
policies.post('/:id/refine', async (c) => c.json({ error: 'not implemented' }, 501))

// GET /policies/:id/refine/status
policies.get('/:id/refine/status', async (c) => c.json({ error: 'not implemented' }, 501))

// GET /policies/:id/coverage
policies.get('/:id/coverage', async (c) => c.json({ error: 'not implemented' }, 501))
