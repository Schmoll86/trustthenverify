/**
 * Rate limiting middleware — per-agent sliding window counters via Cloudflare KV.
 * Runs after auth (needs agentId). Unauthenticated GETs are skipped.
 *
 * Key format: rl:{agentId}:{minuteBucket} with 120s TTL (auto-cleanup).
 * Limits: writes (POST/PUT/DELETE) = 60/min, reads (GET) = 300/min.
 */

import type { Context, Next } from 'hono'

const WRITE_LIMIT = 60
const READ_LIMIT = 300
const BUCKET_TTL = 120 // seconds — covers current + previous minute

export async function rateLimitMiddleware(c: Context, next: Next) {
  const agentId = c.get('agentId') as string | undefined
  if (!agentId) {
    // Unauthenticated (e.g. GET /escrow/:id) — skip
    return next()
  }

  const kv = c.env.RATE_LIMIT_KV as KVNamespace | undefined
  if (!kv) {
    // KV not bound (dev/test without KV) — skip
    return next()
  }

  const method = c.req.method
  const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
  const limit = isWrite ? WRITE_LIMIT : READ_LIMIT
  const prefix = isWrite ? 'w' : 'r'

  const minuteBucket = Math.floor(Date.now() / 60_000)
  const key = `rl:${prefix}:${agentId}:${minuteBucket}`

  const current = parseInt(await kv.get(key) ?? '0', 10)

  if (current >= limit) {
    const secondsUntilReset = 60 - Math.floor((Date.now() % 60_000) / 1000)
    c.header('Retry-After', String(secondsUntilReset))
    c.header('X-RateLimit-Limit', String(limit))
    c.header('X-RateLimit-Remaining', '0')
    return c.json(
      {
        error: { code: 'RATE_LIMITED', message: `Rate limit exceeded. Try again in ${secondsUntilReset}s.` },
        meta: { requestId: crypto.randomUUID() },
      },
      429 as unknown as 200,
    )
  }

  await kv.put(key, String(current + 1), { expirationTtl: BUCKET_TTL })

  c.header('X-RateLimit-Limit', String(limit))
  c.header('X-RateLimit-Remaining', String(limit - current - 1))

  return next()
}
