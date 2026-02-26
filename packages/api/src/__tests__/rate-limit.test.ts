import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { rateLimitMiddleware } from '../middleware/rate-limit'
import { createMockKV } from './helpers/mock-kv'

describe('Rate Limit Middleware', () => {
  let kv: ReturnType<typeof createMockKV>
  let app: Hono

  beforeEach(() => {
    kv = createMockKV()

    app = new Hono()

    // Simulate auth by setting agentId
    app.use('*', async (c, next) => {
      const agentId = c.req.header('X-Test-AgentId')
      if (agentId) c.set('agentId', agentId)
      return next()
    })

    app.use('*', rateLimitMiddleware)

    app.post('/v2/test', (c) => c.json({ ok: true }))
    app.get('/v2/test', (c) => c.json({ ok: true }))
  })

  it('passes requests under the limit', async () => {
    const res = await app.request('/v2/test', {
      method: 'POST',
      headers: { 'X-Test-AgentId': 'agent-1' },
    }, { RATE_LIMIT_KV: kv })

    expect(res.status).toBe(200)
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60')
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('59')
  })

  it('returns 429 when write limit exceeded', async () => {
    // Pre-fill KV to the limit
    const minuteBucket = Math.floor(Date.now() / 60_000)
    await kv.put(`rl:w:agent-1:${minuteBucket}`, '60', { expirationTtl: 120 })

    const res = await app.request('/v2/test', {
      method: 'POST',
      headers: { 'X-Test-AgentId': 'agent-1' },
    }, { RATE_LIMIT_KV: kv })

    expect(res.status).toBe(429)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0')
  })

  it('returns 429 when read limit exceeded', async () => {
    const minuteBucket = Math.floor(Date.now() / 60_000)
    await kv.put(`rl:r:agent-1:${minuteBucket}`, '300', { expirationTtl: 120 })

    const res = await app.request('/v2/test', {
      method: 'GET',
      headers: { 'X-Test-AgentId': 'agent-1' },
    }, { RATE_LIMIT_KV: kv })

    expect(res.status).toBe(429)
  })

  it('tracks agents independently', async () => {
    const minuteBucket = Math.floor(Date.now() / 60_000)
    await kv.put(`rl:w:agent-1:${minuteBucket}`, '60', { expirationTtl: 120 })

    // agent-1 is rate limited
    const res1 = await app.request('/v2/test', {
      method: 'POST',
      headers: { 'X-Test-AgentId': 'agent-1' },
    }, { RATE_LIMIT_KV: kv })
    expect(res1.status).toBe(429)

    // agent-2 is fine
    const res2 = await app.request('/v2/test', {
      method: 'POST',
      headers: { 'X-Test-AgentId': 'agent-2' },
    }, { RATE_LIMIT_KV: kv })
    expect(res2.status).toBe(200)
  })

  it('skips unauthenticated requests', async () => {
    const res = await app.request('/v2/test', {
      method: 'GET',
      // No X-Test-AgentId header
    }, { RATE_LIMIT_KV: kv })

    expect(res.status).toBe(200)
  })

  it('skips when KV not bound', async () => {
    // Set agentId but no KV binding
    app.use('*', async (c, next) => {
      c.set('agentId', 'agent-1')
      return next()
    })

    const res = await app.request('/v2/test', {
      method: 'POST',
      headers: { 'X-Test-AgentId': 'agent-1' },
    }, {})

    expect(res.status).toBe(200)
  })

  it('has Retry-After header on 429', async () => {
    const minuteBucket = Math.floor(Date.now() / 60_000)
    await kv.put(`rl:w:agent-1:${minuteBucket}`, '60', { expirationTtl: 120 })

    const res = await app.request('/v2/test', {
      method: 'POST',
      headers: { 'X-Test-AgentId': 'agent-1' },
    }, { RATE_LIMIT_KV: kv })

    expect(res.status).toBe(429)
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '0', 10)
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(60)
  })
})
