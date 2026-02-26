import { createMiddleware } from 'hono/factory'
import { sha256 } from '@noble/hashes/sha2.js'
import { verify } from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { Env } from '../lib/db'
import { error } from '../lib/response'

type AppEnv = {
  Bindings: Env
  Variables: {
    agentPubkey?: string
    agentId?: string
    sandboxMode?: boolean
    rawBody?: string
  }
}

function sha256Hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)))
}

function buildCanonicalString(method: string, path: string, body: string, timestamp: number): string {
  return `${timestamp}\n${method}\n${path}\n${sha256Hex(body)}`
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  // GET requests are public reads — no auth required
  if (c.req.method === 'GET') {
    return next()
  }

  // Read raw body once and store for route handlers
  const rawBody = await c.req.text()
  c.set('rawBody', rawBody)

  // Sandbox auth: X-Sandbox-Key header bypasses ECDSA
  const sandboxKey = c.req.header('X-Sandbox-Key')
  if (sandboxKey) {
    const validKeys = (c.env.SANDBOX_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean)
    if (validKeys.length === 0 || validKeys.includes(sandboxKey)) {
      c.set('sandboxMode', true)

      // In sandbox mode, identify agent via X-Agent-Pubkey header or body.publicKey
      const sandboxPubkey = c.req.header('X-Agent-Pubkey')
      if (sandboxPubkey) {
        c.set('agentPubkey', sandboxPubkey)
      } else {
        try {
          const parsed = JSON.parse(rawBody)
          if (parsed.publicKey) {
            c.set('agentPubkey', parsed.publicKey)
          }
        } catch {
          // non-JSON body is fine for some endpoints
        }
      }

      // Skip DB lookup for agent registration (agent doesn't exist yet)
      const routePath = new URL(c.req.url).pathname
      if (c.req.method === 'POST' && routePath === '/v2/agents') {
        return next()
      }

      // Look up agentId from pubkey (same as ECDSA path)
      const pubkeyForLookup = c.get('agentPubkey')
      if (pubkeyForLookup) {
        const { createDb } = await import('../lib/db')
        const db = createDb(c.env)
        const { data: agent } = await db
          .from('agents')
          .select('id')
          .eq('public_key', pubkeyForLookup)
          .single()

        if (agent) {
          c.set('agentId', agent.id)
        }
      }

      return next()
    }
    return error(c, 401, 'SIGNATURE_INVALID', 'Invalid sandbox key')
  }

  // ECDSA auth
  const pubkey = c.req.header('X-Agent-Pubkey')
  const timestampStr = c.req.header('X-Agent-Timestamp')
  const signature = c.req.header('X-Agent-Signature')

  if (!pubkey || !timestampStr || !signature) {
    return error(c, 401, 'SIGNATURE_INVALID', 'Missing authentication headers: X-Agent-Pubkey, X-Agent-Timestamp, X-Agent-Signature')
  }

  // Replay protection: |now - timestamp| > 30s
  const timestamp = parseInt(timestampStr, 10)
  const now = Math.floor(Date.now() / 1000)
  if (isNaN(timestamp) || Math.abs(now - timestamp) > 30) {
    return error(c, 401, 'SIGNATURE_INVALID', 'Request timestamp expired or invalid (must be within 30 seconds)')
  }

  // Verify signature
  const path = new URL(c.req.url).pathname.replace('/v2', '')
  const canonical = buildCanonicalString(c.req.method, path, rawBody, timestamp)
  const msgHash = sha256(new TextEncoder().encode(canonical))

  let valid: boolean
  try {
    valid = verify(hexToBytes(signature), msgHash, hexToBytes(pubkey), { prehash: false })
  } catch {
    return error(c, 401, 'SIGNATURE_INVALID', 'Malformed signature or public key')
  }

  if (!valid) {
    return error(c, 401, 'SIGNATURE_INVALID', 'Request signature verification failed')
  }

  c.set('agentPubkey', pubkey)

  // Special case: POST /agents is self-authenticated (no DB lookup needed)
  const routePath = new URL(c.req.url).pathname
  if (c.req.method === 'POST' && routePath === '/v2/agents') {
    return next()
  }

  // All other writes: verify pubkey exists in agents table
  const { createDb } = await import('../lib/db')
  const db = createDb(c.env)
  const { data: agent } = await db
    .from('agents')
    .select('id')
    .eq('public_key', pubkey)
    .single()

  if (!agent) {
    return error(c, 401, 'SIGNATURE_INVALID', 'Agent not registered')
  }

  c.set('agentId', agent.id)
  return next()
})
