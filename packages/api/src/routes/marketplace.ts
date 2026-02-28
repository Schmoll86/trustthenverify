/**
 * Policy marketplace routes — browse and clone community-shared policies.
 * Per SPEC-v2 §3.3.
 */

import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { snakeToCamel } from '../lib/case'
import { success, error } from '../lib/response'
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

export const marketplace = new Hono<AppEnv>()

// GET /marketplace — list community-shared policy templates
// Query params: ?search= (name/intent substring), ?sort=usage|newest (default: usage)
marketplace.get('/', async (c) => {
  const db = createDb(c.env)
  const search = c.req.query('search')
  const sort = c.req.query('sort') || 'usage'

  let query = db
    .from('policies')
    .select('*')
    .eq('status', 'active')
    .eq('visibility', 'public')

  // Text search on name and intent
  if (search && search.length >= 2) {
    query = query.or(`name.ilike.%${search}%,intent.ilike.%${search}%`)
  }

  if (sort === 'newest') {
    query = query.order('created_at', { ascending: false })
  } else {
    query = query.order('usage_count', { ascending: false })
  }

  const { data: rows, error: dbError } = await query

  if (dbError) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fetch marketplace policies')
  }

  const policies = (rows || []).map((r: Record<string, unknown>) => snakeToCamel<Policy>(r))

  return c.json({
    data: policies,
    meta: {
      requestId: crypto.randomUUID(),
      count: policies.length,
    },
  })
})

// POST /marketplace/:id/use — clone a marketplace policy for the caller's use
marketplace.post('/:id/use', async (c) => {
  const callerId = c.get('agentId')
  if (!callerId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const policyId = c.req.param('id')
  const db = createDb(c.env)

  // Fetch the source policy
  const { data: source } = await db
    .from('policies')
    .select('*')
    .eq('id', policyId)
    .eq('visibility', 'public')
    .single()

  if (!source) {
    return error(c, 404, 'NOT_FOUND', 'Marketplace policy not found')
  }

  // Clone the policy for the caller
  const { data: clone, error: cloneErr } = await db
    .from('policies')
    .insert({
      name: `${source.name} (clone)`,
      description: source.description,
      intent: source.intent,
      formal_spec: source.formal_spec,
      version: 1,
      status: 'active',
      billing: 'marketplace',
      billing_model: source.billing_model ?? 'free',
      visibility: 'private',
      parent_version: policyId,
      created_by: callerId,
    })
    .select()
    .single()

  if (cloneErr || !clone) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to clone policy')
  }

  // Increment usage counter on the source policy (non-critical)
  await db
    .from('policies')
    .update({ usage_count: (source.usage_count ?? 0) + 1 })
    .eq('id', policyId)

  return success(c, snakeToCamel<Policy>(clone), 201)
})
