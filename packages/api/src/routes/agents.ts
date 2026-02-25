import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { snakeToCamel } from '../lib/case'
import { success, error } from '../lib/response'
import type { Agent } from '@trustthenverify/sdk'
import type { AgentRow } from '../lib/types'

type AppEnv = {
  Bindings: Env
  Variables: {
    agentPubkey?: string
    agentId?: string
    sandboxMode?: boolean
    rawBody?: string
  }
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
