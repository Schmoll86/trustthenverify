import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { snakeToCamel } from '../lib/case'
import { success, error } from '../lib/response'
import type { Agent } from '@trustthenverify/sdk'
import type { AgentRow } from '../lib/types'
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
