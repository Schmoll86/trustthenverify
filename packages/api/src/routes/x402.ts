/**
 * Public x402 routes — no auth required.
 * Mounted before auth middleware for open access.
 */

import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { RealX402Service } from '../lib/x402'

type AppEnv = {
  Bindings: Env
  Variables: Record<string, never>
}

export const x402 = new Hono<AppEnv>()

function getX402Svc(env: Env): RealX402Service {
  return new RealX402Service(
    env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    env.GATEWAY_EOA_PRIVATE_KEY ?? env.GATEWAY_PRIVATE_KEY ?? '',
    parseInt(env.BASE_CHAIN_ID ?? '8453', 10),
    env.USDC_CONTRACT_ADDRESS,
  )
}

// GET /v2/x402/balance/:address — check USDC balance on Base
x402.get('/balance/:address', async (c) => {
  const address = c.req.param('address')
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return c.json({ error: { code: 'INVALID_PARAMS', message: 'Invalid Ethereum address' }, meta: { requestId: crypto.randomUUID() } }, 400)
  }

  const svc = getX402Svc(c.env)
  try {
    const { balance, balanceRaw } = await svc.checkBalance(address)
    return c.json({ data: { address, balance, balanceRaw }, meta: { requestId: crypto.randomUUID() } })
  } catch (err) {
    return c.json({ error: { code: 'RPC_ERROR', message: err instanceof Error ? err.message : 'Balance check failed' }, meta: { requestId: crypto.randomUUID() } }, 502)
  }
})

// POST /v2/x402/verify-macaroon — verify macaroon signature (free/public)
x402.post('/verify-macaroon', async (c) => {
  let body: { macaroon: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: { code: 'INVALID_PARAMS', message: 'Invalid JSON body' }, meta: { requestId: crypto.randomUUID() } }, 400)
  }

  if (!body.macaroon || typeof body.macaroon !== 'string') {
    return c.json({ error: { code: 'INVALID_PARAMS', message: 'macaroon is required' }, meta: { requestId: crypto.randomUUID() } }, 400)
  }

  const svc = getX402Svc(c.env)
  const result = await svc.verifyMacaroon(body.macaroon)
  return c.json({ data: result, meta: { requestId: crypto.randomUUID() } })
})
