/**
 * .well-known/* discovery manifests.
 *
 * - `/.well-known/x402.json` — facilitator manifest for x402 Foundation clients.
 * - `/.well-known/ai-plugin.json` — machine-readable description for MCP
 *   registries and passive crawlers (glama.ai/mcp, modelcontextprotocol.io).
 *
 * Mounted BEFORE authMiddleware in index.ts. No auth, no rate limit.
 * Gateway address is derived on demand from GATEWAY_EOA_PRIVATE_KEY; the
 * result is stable per-deployment so we cache it at module load.
 */

import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { privateKeyToEthAddress } from '../lib/eth-utils'

type AppEnv = {
  Bindings: Env
  Variables: Record<string, never>
}

export const wellKnown = new Hono<AppEnv>()

let cachedGatewayAddress: string | null = null

async function getGatewayAddress(env: Env): Promise<string | null> {
  if (cachedGatewayAddress) return cachedGatewayAddress
  const key = env.GATEWAY_EOA_PRIVATE_KEY ?? env.GATEWAY_PRIVATE_KEY
  if (!key) return null
  try {
    cachedGatewayAddress = await privateKeyToEthAddress(key)
    return cachedGatewayAddress
  } catch {
    return null
  }
}

const DEFAULT_USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// GET /.well-known/x402.json — facilitator manifest
wellKnown.get('/x402.json', async (c) => {
  const env = c.env
  const chainId = parseInt(env.BASE_CHAIN_ID ?? '8453', 10)
  const usdcContract = env.USDC_CONTRACT_ADDRESS ?? DEFAULT_USDC_CONTRACT
  const gatewayAddress = await getGatewayAddress(env)

  return c.json({
    version: '1',
    schema: 'https://x402.org/schemas/facilitator/v1',
    facilitator: {
      operator: 'TrustThenVerify',
      contact: 'https://trustthenverify.com',
      gatewayAddress,
      chains: [
        {
          caip2: `eip155:${chainId}`,
          chainId,
          name: chainId === 8453 ? 'Base' : 'Base Sepolia',
          usdcContract,
        },
      ],
    },
    capabilities: ['escrow', 'macaroon', 'settle'],
    fees: {
      settlementBps: 1000,
      notes: '10% on dispute resolution; 0% on happy-path release',
    },
    endpoints: {
      balance: '/v2/x402/balance/{address}',
      verifyMacaroon: '/v2/x402/verify-macaroon',
      health: '/v2/health',
    },
    sdk: { npm: '@trustthenverify/sdk', version: '^0.3.0' },
    mcp: {
      npm: '@trustthenverify/mcp',
      install: 'claude mcp add trustthenverify -- npx -y @trustthenverify/mcp',
    },
  })
})

// GET /.well-known/ai-plugin.json — MCP-registry manifest
wellKnown.get('/ai-plugin.json', (c) => {
  return c.json({
    schema_version: 'v1',
    name_for_model: 'trustthenverify',
    name_for_human: 'TrustThenVerify',
    description_for_model:
      'Escrow + verification protocol for autonomous AI agent commerce. USDC payments on Base L2 via x402. Formal policy verification, LLM-arbitrated disputes, oracle consensus.',
    description_for_human: 'Agent-to-agent escrow with x402 USDC + game-theoretic verification.',
    mcp: {
      npm: '@trustthenverify/mcp',
      install: 'claude mcp add trustthenverify -- npx -y @trustthenverify/mcp',
      tools_count: 46,
      primary_tool: 'trust_x402_buy',
    },
    auth: {
      type: 'ecdsa-secp256k1',
      details: 'Agent registers with its own keypair; MCP auto-generates on first run.',
    },
    api: { url: 'https://api.trustthenverify.com/.well-known/x402.json' },
    contact_email: 'hello@trustthenverify.com',
    legal_info_url: 'https://trustthenverify.com/terms',
  })
})
