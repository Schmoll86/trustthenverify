import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { snakeToCamel } from '../lib/case'
import { success, error } from '../lib/response'
import type { Agent } from '@trustthenverify/sdk'
import type { AgentRow, EscrowRow } from '../lib/types'
import type { StripeService } from '../lib/stripe'
import { RealStripeService } from '../lib/stripe'

type AppEnv = {
  Bindings: Env
  Variables: {
    agentPubkey?: string
    agentId?: string
    sandboxMode?: boolean
    rawBody?: string
    stripe?: StripeService
  }
}

/** Get or create StripeService. Tests inject via c.set('stripe', mock). */
function getStripe(c: { env: Env; get(key: 'stripe'): StripeService | undefined }): StripeService {
  const injected = c.get('stripe')
  if (injected) return injected
  return new RealStripeService(c.env.STRIPE_SECRET_KEY)
}

export const agents = new Hono<AppEnv>()

// POST /agents — register (pubkey + endpoint + capabilities)
agents.post('/', async (c) => {
  const rawBody = c.get('rawBody')
  let body: { publicKey: string; endpoint?: string; name?: string; capabilities?: string[] }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  if (!body.publicKey || typeof body.publicKey !== 'string') {
    return error(c, 400, 'INVALID_PARAMS', 'publicKey is required and must be a hex string')
  }

  // Validate pubkey format (compressed secp256k1 = 66 hex chars)
  if (!/^[0-9a-f]{66}$/i.test(body.publicKey)) {
    return error(c, 400, 'INVALID_PARAMS', 'publicKey must be a 33-byte compressed secp256k1 key (66 hex chars)')
  }

  const db = createDb(c.env)

  // Check uniqueness
  const { data: existing } = await db
    .from('agents')
    .select('id')
    .eq('public_key', body.publicKey)
    .single()

  if (existing) {
    return error(c, 409, 'ALREADY_EXISTS', 'Agent with this publicKey already registered')
  }

  const { data: row, error: dbError } = await db
    .from('agents')
    .insert({
      public_key: body.publicKey,
      endpoint: body.endpoint ?? null,
      name: body.name ?? null,
      capabilities: body.capabilities ?? [],
      metadata: {},
      email: (body as Record<string, unknown>).email ?? null,
    })
    .select()
    .single()

  if (dbError || !row) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create agent')
  }

  return success(c, snakeToCamel<Agent>(row), 201)
})

// GET /agents/search — search by capabilities (must be before /:pubkey)
agents.get('/search', async (c) => {
  const capabilitiesParam = c.req.query('capabilities')
  if (!capabilitiesParam) {
    return error(c, 400, 'INVALID_PARAMS', 'capabilities query parameter is required')
  }

  const capabilities = capabilitiesParam.split(',').map((s) => s.trim()).filter(Boolean)
  const match = c.req.query('match') || 'any'
  const cursor = c.req.query('cursor')

  const db = createDb(c.env)

  let query = db.from('agents').select('*')

  if (match === 'all') {
    // Agent must have ALL requested capabilities
    for (const cap of capabilities) {
      query = query.contains('capabilities', JSON.stringify([cap]))
    }
  } else {
    // Agent must have ANY of the requested capabilities
    // Use OR filter with contains for each capability
    const orFilters = capabilities.map((cap) => `capabilities.cs.${JSON.stringify([cap])}`).join(',')
    query = query.or(orFilters)
  }

  // Keyset pagination using created_at + id
  if (cursor) {
    try {
      const decoded = JSON.parse(atob(cursor))
      query = query.or(`created_at.lt.${decoded.created_at},and(created_at.eq.${decoded.created_at},id.gt.${decoded.id})`)
    } catch {
      // Invalid cursor, ignore
    }
  }

  query = query.order('created_at', { ascending: false }).limit(20)

  const { data: rows, error: dbError } = await query

  if (dbError) {
    return error(c, 500, 'INTERNAL_ERROR', 'Search failed')
  }

  const agents = (rows || []).map((r: AgentRow) => snakeToCamel<Agent>(r))
  let nextCursor: string | null = null

  if (rows && rows.length === 20) {
    const last = rows[rows.length - 1]
    nextCursor = btoa(JSON.stringify({ created_at: last.created_at, id: last.id }))
  }

  return c.json({
    data: agents,
    meta: {
      requestId: crypto.randomUUID(),
      count: agents.length,
      cursor: nextCursor,
    },
  })
})

// GET /agents/stats/batch — batch stats for multiple agents
agents.get('/stats/batch', async (c) => {
  const pubkeysParam = c.req.query('pubkeys')
  if (!pubkeysParam) {
    return error(c, 400, 'INVALID_PARAMS', 'pubkeys query parameter is required')
  }

  const pubkeys = pubkeysParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20)
  if (pubkeys.length === 0) {
    return success(c, {})
  }

  const db = createDb(c.env)

  // Fetch agents matching these pubkeys
  const { data: agentRows } = await db
    .from('agents')
    .select('id, public_key')
    .in('public_key', pubkeys)

  if (!agentRows || agentRows.length === 0) {
    return success(c, {})
  }

  const agents = agentRows as Array<{ id: string; public_key: string }>
  const agentIds = agents.map(a => a.id)

  // Fetch escrows involving any of these agents
  const orFilters = agentIds.map(id => `buyer_id.eq.${id},seller_id.eq.${id}`).join(',')
  const { data: escrowRows } = await db
    .from('escrows')
    .select('status, amount_cents, buyer_id, seller_id')
    .or(orFilters)

  const escrows = (escrowRows || []) as Array<{ status: string; amount_cents: number; buyer_id: string; seller_id: string }>

  // Build stats per agent
  const result: Record<string, { totalEscrows: number; released: number; successRate: number | null; totalValueCents: number }> = {}

  for (const agent of agents) {
    const agentEscrows = escrows.filter(e => e.buyer_id === agent.id || e.seller_id === agent.id)
    const released = agentEscrows.filter(e => e.status === 'released')
    const terminal = agentEscrows.filter(e => ['released', 'failed', 'burned', 'expired', 'resolved'].includes(e.status))
    const totalValueCents = released.reduce((sum, e) => sum + e.amount_cents, 0)

    result[agent.public_key] = {
      totalEscrows: agentEscrows.length,
      released: released.length,
      successRate: terminal.length > 0 ? Math.round((released.length / terminal.length) * 100) : null,
      totalValueCents,
    }
  }

  return success(c, result)
})

// GET /agents/:pubkey — lookup
agents.get('/:pubkey', async (c) => {
  const pubkey = c.req.param('pubkey')
  const db = createDb(c.env)

  const { data: row, error: dbError } = await db
    .from('agents')
    .select('*')
    .eq('public_key', pubkey)
    .single()

  if (dbError || !row) {
    return error(c, 404, 'NOT_FOUND', `Agent not found: ${pubkey}`)
  }

  return success(c, snakeToCamel<Agent>(row))
})

// GET /agents/:pubkey/escrows — list escrows for an agent
agents.get('/:pubkey/escrows', async (c) => {
  const pubkey = c.req.param('pubkey')
  const db = createDb(c.env)

  // Verify agent exists
  const { data: agent } = await db
    .from('agents')
    .select('id')
    .eq('public_key', pubkey)
    .single()

  if (!agent) {
    return error(c, 404, 'NOT_FOUND', `Agent not found: ${pubkey}`)
  }

  const agentId = (agent as { id: string }).id
  const status = c.req.query('status')
  const role = c.req.query('role') // 'buyer' | 'seller' | undefined (both)
  const cursor = c.req.query('cursor')

  let query = db.from('escrows').select('*')

  // Filter by role
  if (role === 'buyer') {
    query = query.eq('buyer_id', agentId)
  } else if (role === 'seller') {
    query = query.eq('seller_id', agentId)
  } else {
    query = query.or(`buyer_id.eq.${agentId},seller_id.eq.${agentId}`)
  }

  // Filter by status
  if (status) {
    query = query.eq('status', status)
  }

  // Keyset pagination
  if (cursor) {
    try {
      const decoded = JSON.parse(atob(cursor))
      query = query.or(`created_at.lt.${decoded.created_at},and(created_at.eq.${decoded.created_at},id.gt.${decoded.id})`)
    } catch {
      // Invalid cursor, ignore
    }
  }

  query = query.order('created_at', { ascending: false }).limit(20)

  const { data: rows, error: dbError } = await query

  if (dbError) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list escrows')
  }

  const escrows = (rows || []).map((r: EscrowRow) => snakeToCamel(r))
  let nextCursor: string | null = null

  if (rows && rows.length === 20) {
    const last = rows[rows.length - 1] as EscrowRow
    nextCursor = btoa(JSON.stringify({ created_at: last.created_at, id: last.id }))
  }

  return c.json({
    data: escrows,
    meta: {
      requestId: crypto.randomUUID(),
      count: escrows.length,
      cursor: nextCursor,
    },
  })
})

// POST /agents/:pubkey/update — update agent profile
agents.post('/:pubkey/update', async (c) => {
  const pubkey = c.req.param('pubkey')
  const callerPubkey = c.get('agentPubkey')

  if (callerPubkey !== pubkey) {
    return error(c, 403, 'FORBIDDEN', 'Can only update your own agent')
  }

  const rawBody = c.get('rawBody')
  let body: { name?: string; endpoint?: string; capabilities?: string[]; metadata?: Record<string, unknown> }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.endpoint !== undefined) updates.endpoint = body.endpoint
  if (body.capabilities !== undefined) {
    if (!Array.isArray(body.capabilities)) {
      return error(c, 400, 'INVALID_PARAMS', 'capabilities must be an array of strings')
    }
    updates.capabilities = body.capabilities
  }
  if (body.metadata !== undefined) {
    if (typeof body.metadata !== 'object' || body.metadata === null) {
      return error(c, 400, 'INVALID_PARAMS', 'metadata must be an object')
    }
    updates.metadata = body.metadata
  }

  if (Object.keys(updates).length === 0) {
    return error(c, 400, 'INVALID_PARAMS', 'Nothing to update. Provide name, endpoint, capabilities, or metadata.')
  }

  const db = createDb(c.env)

  const { data: updated, error: dbError } = await db
    .from('agents')
    .update(updates)
    .eq('public_key', pubkey)
    .select()
    .single()

  if (dbError || !updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update agent')
  }

  return success(c, snakeToCamel<Agent>(updated))
})

// GET /agents/:pubkey/policies — list policies created by this agent
agents.get('/:pubkey/policies', async (c) => {
  const pubkey = c.req.param('pubkey')
  const db = createDb(c.env)

  // Resolve pubkey → agent ID
  const { data: agent } = await db
    .from('agents')
    .select('id')
    .eq('public_key', pubkey)
    .single()

  if (!agent) {
    return error(c, 404, 'NOT_FOUND', `Agent not found: ${pubkey}`)
  }

  const agentId = (agent as { id: string }).id
  const status = c.req.query('status')
  const cursor = c.req.query('cursor')

  let query = db.from('policies').select('*').eq('created_by', agentId)

  if (status) {
    query = query.eq('status', status)
  }

  if (cursor) {
    try {
      const decoded = JSON.parse(atob(cursor))
      query = query.or(`created_at.lt.${decoded.created_at},and(created_at.eq.${decoded.created_at},id.gt.${decoded.id})`)
    } catch {
      // Invalid cursor, ignore
    }
  }

  query = query.order('created_at', { ascending: false }).limit(20)

  const { data: rows, error: dbError } = await query

  if (dbError) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to list policies')
  }

  const policies = (rows || []).map((r: Record<string, unknown>) => snakeToCamel(r))
  let nextCursor: string | null = null

  if (rows && rows.length === 20) {
    const last = rows[rows.length - 1] as { created_at: string; id: string }
    nextCursor = btoa(JSON.stringify({ created_at: last.created_at, id: last.id }))
  }

  return c.json({
    data: policies,
    meta: {
      requestId: crypto.randomUUID(),
      count: policies.length,
      cursor: nextCursor,
    },
  })
})

// GET /agents/:pubkey/stats — commerce statistics
agents.get('/:pubkey/stats', async (c) => {
  const pubkey = c.req.param('pubkey')
  const db = createDb(c.env)

  const { data: agent } = await db
    .from('agents')
    .select('id')
    .eq('public_key', pubkey)
    .single()

  if (!agent) {
    return error(c, 404, 'NOT_FOUND', `Agent not found: ${pubkey}`)
  }

  const agentId = (agent as { id: string }).id

  // Fetch all escrows for this agent (select minimal columns)
  const { data: rows } = await db
    .from('escrows')
    .select('status, amount_cents, buyer_id, seller_id')
    .or(`buyer_id.eq.${agentId},seller_id.eq.${agentId}`)

  const escrows = (rows || []) as Array<{ status: string; amount_cents: number; buyer_id: string; seller_id: string }>

  const asBuyer = escrows.filter(e => e.buyer_id === agentId)
  const asSeller = escrows.filter(e => e.seller_id === agentId)

  const terminal = ['released', 'failed', 'burned', 'expired', 'resolved']
  const completed = escrows.filter(e => terminal.includes(e.status))
  const released = escrows.filter(e => e.status === 'released')
  const disputed = escrows.filter(e => e.status === 'disputed' || e.status === 'resolved')

  const totalValueCents = released.reduce((sum, e) => sum + e.amount_cents, 0)
  const successRate = completed.length > 0
    ? Math.round((released.length / completed.length) * 100) / 100
    : null

  // Count unique counterparties
  const counterparties = new Set<string>()
  for (const e of escrows) {
    if (e.buyer_id === agentId) counterparties.add(e.seller_id)
    else counterparties.add(e.buyer_id)
  }

  return success(c, {
    totalEscrows: escrows.length,
    asBuyer: asBuyer.length,
    asSeller: asSeller.length,
    released: released.length,
    failed: escrows.filter(e => e.status === 'failed').length,
    disputed: disputed.length,
    expired: escrows.filter(e => e.status === 'expired').length,
    totalValueCents,
    successRate,
    uniqueCounterparties: counterparties.size,
  })
})

// POST /agents/:pubkey/verify — keypair verification challenge
agents.post('/:pubkey/verify', async (c) => {
  // If auth middleware passed, the agent is verified (signature was valid)
  return success(c, { verified: true })
})

// POST /agents/:pubkey/spawn — spawn child agent
agents.post('/:pubkey/spawn', async (c) => {
  const parentPubkey = c.req.param('pubkey')
  const callerPubkey = c.get('agentPubkey')

  // Can only spawn children of yourself
  if (callerPubkey !== parentPubkey) {
    return error(c, 403, 'FORBIDDEN', 'Can only spawn children of your own agent')
  }

  const rawBody = c.get('rawBody')
  let body: { publicKey: string; endpoint?: string; name?: string; capabilities?: string[] }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  if (!body.publicKey || typeof body.publicKey !== 'string') {
    return error(c, 400, 'INVALID_PARAMS', 'publicKey is required for child agent')
  }

  if (!/^[0-9a-f]{66}$/i.test(body.publicKey)) {
    return error(c, 400, 'INVALID_PARAMS', 'publicKey must be a 33-byte compressed secp256k1 key (66 hex chars)')
  }

  const db = createDb(c.env)

  // Get parent agent ID
  const { data: parent } = await db
    .from('agents')
    .select('id')
    .eq('public_key', parentPubkey)
    .single()

  if (!parent) {
    return error(c, 404, 'NOT_FOUND', 'Parent agent not found')
  }

  // Check child uniqueness
  const { data: existing } = await db
    .from('agents')
    .select('id')
    .eq('public_key', body.publicKey)
    .single()

  if (existing) {
    return error(c, 409, 'ALREADY_EXISTS', 'Agent with this publicKey already registered')
  }

  const { data: row, error: dbError } = await db
    .from('agents')
    .insert({
      public_key: body.publicKey,
      endpoint: body.endpoint ?? null,
      name: body.name ?? null,
      capabilities: body.capabilities ?? [],
      metadata: {},
      parent_id: parent.id,
    })
    .select()
    .single()

  if (dbError || !row) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to spawn child agent')
  }

  return success(c, snakeToCamel<Agent>(row), 201)
})

// ── Stripe onboarding routes ──────────────────────────────────────────────

// POST /agents/:pubkey/stripe/customer — create Stripe Customer for buyer
agents.post('/:pubkey/stripe/customer', async (c) => {
  const pubkey = c.req.param('pubkey')
  const callerPubkey = c.get('agentPubkey')

  if (callerPubkey !== pubkey) {
    return error(c, 403, 'FORBIDDEN', 'Can only set up Stripe for your own agent')
  }

  const db = createDb(c.env)
  const { data: agent } = await db
    .from('agents')
    .select('*')
    .eq('public_key', pubkey)
    .single()

  if (!agent) {
    return error(c, 404, 'NOT_FOUND', `Agent not found: ${pubkey}`)
  }

  const row = agent as AgentRow
  if (row.stripe_customer_id) {
    return error(c, 409, 'ALREADY_EXISTS', 'Agent already has a Stripe Customer')
  }

  const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
  const { customerId } = await stripe.createCustomer({
    agentId: row.id,
    name: row.name ?? undefined,
  })

  const { data: updated } = await db
    .from('agents')
    .update({ stripe_customer_id: customerId })
    .eq('id', row.id)
    .select()
    .single()

  if (!updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update agent')
  }

  return success(c, snakeToCamel<Agent>(updated))
})

// POST /agents/:pubkey/stripe/connect — create Express account for seller
agents.post('/:pubkey/stripe/connect', async (c) => {
  const pubkey = c.req.param('pubkey')
  const callerPubkey = c.get('agentPubkey')

  if (callerPubkey !== pubkey) {
    return error(c, 403, 'FORBIDDEN', 'Can only set up Stripe for your own agent')
  }

  const rawBody = c.get('rawBody')
  let body: { returnUrl?: string; refreshUrl?: string }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  const db = createDb(c.env)
  const { data: agent } = await db
    .from('agents')
    .select('*')
    .eq('public_key', pubkey)
    .single()

  if (!agent) {
    return error(c, 404, 'NOT_FOUND', `Agent not found: ${pubkey}`)
  }

  const row = agent as AgentRow
  if (row.stripe_connected_account_id) {
    return error(c, 409, 'ALREADY_EXISTS', 'Agent already has a Stripe Connect account')
  }

  const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
  const { accountId, onboardingUrl } = await stripe.createConnectAccount({
    agentId: row.id,
    returnUrl: body.returnUrl ?? 'https://trustthenverify.com/onboarding/complete',
    refreshUrl: body.refreshUrl ?? 'https://trustthenverify.com/onboarding/refresh',
  })

  const { data: updated } = await db
    .from('agents')
    .update({ stripe_connected_account_id: accountId })
    .eq('id', row.id)
    .select()
    .single()

  if (!updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update agent')
  }

  return success(c, { agent: snakeToCamel<Agent>(updated), onboardingUrl })
})

// GET /agents/:pubkey/stripe/status — check onboarding completion
agents.get('/:pubkey/stripe/status', async (c) => {
  const pubkey = c.req.param('pubkey')
  const db = createDb(c.env)

  const { data: agent } = await db
    .from('agents')
    .select('*')
    .eq('public_key', pubkey)
    .single()

  if (!agent) {
    return error(c, 404, 'NOT_FOUND', `Agent not found: ${pubkey}`)
  }

  const row = agent as AgentRow
  if (!row.stripe_connected_account_id) {
    return success(c, {
      hasCustomer: !!row.stripe_customer_id,
      hasConnectAccount: false,
      onboardingComplete: false,
      chargesEnabled: false,
      payoutsEnabled: false,
    })
  }

  const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
  const status = await stripe.getAccountStatus(row.stripe_connected_account_id)

  // Auto-update onboarding_complete flag if not yet set
  if (status.chargesEnabled && status.payoutsEnabled && !row.stripe_onboarding_complete) {
    await db
      .from('agents')
      .update({ stripe_onboarding_complete: true })
      .eq('id', row.id)
  }

  return success(c, {
    hasCustomer: !!row.stripe_customer_id,
    hasConnectAccount: true,
    onboardingComplete: status.chargesEnabled && status.payoutsEnabled,
    chargesEnabled: status.chargesEnabled,
    payoutsEnabled: status.payoutsEnabled,
  })
})

// POST /agents/:pubkey/stripe/setup-intent — create SetupIntent for card collection
agents.post('/:pubkey/stripe/setup-intent', async (c) => {
  const pubkey = c.req.param('pubkey')
  const callerPubkey = c.get('agentPubkey')

  if (callerPubkey !== pubkey) {
    return error(c, 403, 'FORBIDDEN', 'Can only create setup intents for your own agent')
  }

  const db = createDb(c.env)
  const { data: agent } = await db
    .from('agents')
    .select('*')
    .eq('public_key', pubkey)
    .single()

  if (!agent) {
    return error(c, 404, 'NOT_FOUND', `Agent not found: ${pubkey}`)
  }

  const row = agent as AgentRow
  if (!row.stripe_customer_id) {
    return error(c, 400, 'INVALID_PARAMS', 'Agent must have a Stripe Customer first. Call POST /agents/:pubkey/stripe/customer')
  }

  // Sandbox mode: return mock values
  if (c.get('sandboxMode')) {
    return success(c, {
      setupIntentId: 'seti_mock_sandbox',
      clientSecret: 'seti_mock_sandbox_secret_test',
    })
  }

  const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
  const result = await stripe.createSetupIntent({
    customerId: row.stripe_customer_id,
    metadata: { agent_id: row.id, platform: 'trustthenverify' },
  })

  return success(c, result)
})

// PATCH /agents/:pubkey/notifications — update email + notification preferences
agents.post('/:pubkey/notifications', async (c) => {
  const pubkey = c.req.param('pubkey')
  const callerPubkey = c.get('agentPubkey')

  if (callerPubkey !== pubkey) {
    return error(c, 403, 'FORBIDDEN', 'Can only update your own notification preferences')
  }

  const rawBody = c.get('rawBody')
  let body: { email?: string; preferences?: Record<string, boolean> }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  const updates: Record<string, unknown> = {}
  if (body.email !== undefined) updates.email = body.email || null
  if (body.preferences !== undefined) updates.notification_preferences = body.preferences

  if (Object.keys(updates).length === 0) {
    return error(c, 400, 'INVALID_PARAMS', 'Provide email or preferences')
  }

  const db = createDb(c.env)
  const { data: updated, error: dbError } = await db
    .from('agents')
    .update(updates)
    .eq('public_key', pubkey)
    .select()
    .single()

  if (dbError || !updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update notification preferences')
  }

  return success(c, snakeToCamel<Agent>(updated))
})

// POST /agents/:pubkey/webhook — register webhook for instant notifications
agents.post('/:pubkey/webhook', async (c) => {
  const pubkey = c.req.param('pubkey')
  const callerPubkey = c.get('agentPubkey')

  if (callerPubkey !== pubkey) {
    return error(c, 403, 'FORBIDDEN', 'Can only register webhooks for your own agent')
  }

  const rawBody = c.get('rawBody')
  let body: { url: string }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  if (!body.url || typeof body.url !== 'string') {
    return error(c, 400, 'INVALID_PARAMS', 'url is required')
  }

  // Validate URL format
  try {
    new URL(body.url)
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'url must be a valid URL')
  }

  const db = createDb(c.env)
  const webhookSecret = crypto.randomUUID()

  const { data: updated, error: dbError } = await db
    .from('agents')
    .update({ webhook_url: body.url, webhook_secret: webhookSecret })
    .eq('public_key', pubkey)
    .select()
    .single()

  if (dbError || !updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to register webhook')
  }

  return success(c, { webhookUrl: body.url, webhookSecret })
})

// POST /agents/:pubkey/stripe/payment-method — attach payment method to Customer
agents.post('/:pubkey/stripe/payment-method', async (c) => {
  const pubkey = c.req.param('pubkey')
  const callerPubkey = c.get('agentPubkey')

  if (callerPubkey !== pubkey) {
    return error(c, 403, 'FORBIDDEN', 'Can only attach payment methods to your own agent')
  }

  const rawBody = c.get('rawBody')
  let body: { paymentMethodId?: string }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  if (!body.paymentMethodId) {
    return error(c, 400, 'INVALID_PARAMS', 'paymentMethodId is required')
  }

  const db = createDb(c.env)
  const { data: agent } = await db
    .from('agents')
    .select('*')
    .eq('public_key', pubkey)
    .single()

  if (!agent) {
    return error(c, 404, 'NOT_FOUND', `Agent not found: ${pubkey}`)
  }

  const row = agent as AgentRow
  if (!row.stripe_customer_id) {
    return error(c, 400, 'INVALID_PARAMS', 'Agent must have a Stripe Customer first. Call POST /agents/:pubkey/stripe/customer')
  }

  if (!c.get('sandboxMode')) {
    const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
    await stripe.attachPaymentMethod({
      customerId: row.stripe_customer_id,
      paymentMethodId: body.paymentMethodId,
    })
  }

  const { data: updated } = await db
    .from('agents')
    .update({ stripe_default_payment_method: body.paymentMethodId })
    .eq('id', row.id)
    .select()
    .single()

  if (!updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update agent')
  }

  return success(c, snakeToCamel<Agent>(updated))
})
