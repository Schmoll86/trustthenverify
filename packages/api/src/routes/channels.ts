import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { success, error } from '../lib/response'
import { snakeToCamel } from '../lib/case'

type AppEnv = {
  Bindings: Env
  Variables: {
    agentPubkey?: string
    agentId?: string
    sandboxMode?: boolean
    rawBody?: string
  }
}

export const channels = new Hono<AppEnv>()

/** Resolve agentId for GET requests (auth middleware skips GET). */
async function resolveAgentId(c: { env: Env; req: { header(name: string): string | undefined }; get(key: 'agentId'): string | undefined }): Promise<string | null> {
  const fromAuth = c.get('agentId')
  if (fromAuth) return fromAuth

  const pubkey = c.req.header('X-Agent-Pubkey')
  if (!pubkey) return null

  const db = createDb(c.env)
  const { data: agent } = await db
    .from('agents')
    .select('id')
    .eq('public_key', pubkey)
    .single()

  return agent?.id ?? null
}

// POST /channels — register a payment channel
channels.post('/', async (c) => {
  const agentId = c.get('agentId')
  if (!agentId) {
    return error(c, 401, 'AUTH_REQUIRED', 'Authentication required')
  }

  const rawBody = c.get('rawBody')
  let body: {
    contractAddress?: string
    counterparty?: string
    depositUsdc?: number
    chainId?: number
    expiration?: string
  }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_JSON', 'Invalid JSON body')
  }

  const { contractAddress, counterparty, depositUsdc, chainId, expiration } = body

  if (!contractAddress) return error(c, 400, 'MISSING_FIELD', 'contractAddress is required')
  if (!counterparty) return error(c, 400, 'MISSING_FIELD', 'counterparty is required')
  if (depositUsdc == null || depositUsdc <= 0) return error(c, 400, 'INVALID_FIELD', 'depositUsdc must be positive')
  if (!chainId) return error(c, 400, 'MISSING_FIELD', 'chainId is required')
  if (!expiration) return error(c, 400, 'MISSING_FIELD', 'expiration is required')

  const db = createDb(c.env)

  // Look up counterparty agent
  const { data: counterpartyAgent } = await db
    .from('agents')
    .select('id')
    .eq('public_key', counterparty)
    .single()

  if (!counterpartyAgent) {
    return error(c, 404, 'AGENT_NOT_FOUND', 'Counterparty agent not found')
  }

  // Insert channel (caller is buyer, counterparty is seller)
  const { data: channel, error: dbError } = await db
    .from('payment_channels')
    .insert({
      contract_address: contractAddress,
      buyer_id: agentId,
      seller_id: counterpartyAgent.id,
      deposit_usdc: depositUsdc,
      chain_id: chainId,
      expiration,
      status: 'open',
    })
    .select()
    .single()

  if (dbError) {
    if (dbError.code === '23505') {
      return error(c, 409, 'DUPLICATE', 'Channel with this contract address already exists')
    }
    return error(c, 500, 'DB_ERROR', dbError.message)
  }

  return success(c, snakeToCamel(channel), 201)
})

// GET /channels/:address — get channel details
channels.get('/:address', async (c) => {
  const agentId = await resolveAgentId(c)
  if (!agentId) {
    return error(c, 401, 'AUTH_REQUIRED', 'Authentication required')
  }

  const address = c.req.param('address')

  const db = createDb(c.env)
  const { data: channel } = await db
    .from('payment_channels')
    .select('*')
    .eq('contract_address', address)
    .single()

  if (!channel) {
    return error(c, 404, 'NOT_FOUND', 'Payment channel not found')
  }

  // Only buyer or seller can view
  if (channel.buyer_id !== agentId && channel.seller_id !== agentId) {
    return error(c, 403, 'FORBIDDEN', 'Not a party to this channel')
  }

  return success(c, snakeToCamel(channel))
})

// POST /channels/:address/close — record channel closure
channels.post('/:address/close', async (c) => {
  const agentId = c.get('agentId')
  if (!agentId) {
    return error(c, 401, 'AUTH_REQUIRED', 'Authentication required')
  }

  const address = c.req.param('address')
  const db = createDb(c.env)

  const { data: channel } = await db
    .from('payment_channels')
    .select('*')
    .eq('contract_address', address)
    .single()

  if (!channel) {
    return error(c, 404, 'NOT_FOUND', 'Payment channel not found')
  }

  if (channel.buyer_id !== agentId && channel.seller_id !== agentId) {
    return error(c, 403, 'FORBIDDEN', 'Not a party to this channel')
  }

  if (channel.status === 'closed') {
    return error(c, 409, 'ALREADY_CLOSED', 'Channel is already closed')
  }

  const { data: updated, error: dbError } = await db
    .from('payment_channels')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', channel.id)
    .select()
    .single()

  if (dbError) {
    return error(c, 500, 'DB_ERROR', dbError.message)
  }

  return success(c, snakeToCamel(updated))
})
