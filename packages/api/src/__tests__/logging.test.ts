import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { loggingMiddleware, errorHandler } from '../middleware/logging'

describe('Logging Middleware', () => {
  let app: Hono
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.restoreAllMocks()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    app = new Hono()
    app.onError(errorHandler)
    app.use('*', loggingMiddleware)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs correct fields on success', async () => {
    app.get('/v2/health', (c) => c.json({ status: 'ok' }))

    const res = await app.request('/v2/health')
    expect(res.status).toBe(200)

    expect(logSpy).toHaveBeenCalledOnce()
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(logged).toMatchObject({
      method: 'GET',
      path: '/v2/health',
      status: 200,
    })
    expect(logged.requestId).toBeTruthy()
    expect(logged.ts).toBeTruthy()
    expect(typeof logged.durationMs).toBe('number')
  })

  it('catches errors and returns 500 envelope', async () => {
    app.get('/v2/boom', () => {
      throw new Error('kaboom')
    })

    const res = await app.request('/v2/boom')
    expect(res.status).toBe(500)

    const body = await res.json() as { error: { code: string }; meta: { requestId: string } }
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(body.meta.requestId).toBeTruthy()

    // Error should be logged
    expect(logSpy).toHaveBeenCalledOnce()
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(logged.status).toBe(500)
    expect(logged.error).toBe('kaboom')
  })

  it('sets requestId in context for downstream use', async () => {
    let capturedRequestId: string | undefined

    app.get('/v2/test', (c) => {
      capturedRequestId = c.get('requestId') as string
      return c.json({ ok: true })
    })

    await app.request('/v2/test')
    expect(capturedRequestId).toBeTruthy()
    expect(capturedRequestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('requestId in log matches response meta', async () => {
    app.get('/v2/test', (c) => {
      const requestId = c.get('requestId') as string
      return c.json({ data: null, meta: { requestId } })
    })

    const res = await app.request('/v2/test')
    const body = await res.json() as { meta: { requestId: string } }

    const logged = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(logged.requestId).toBe(body.meta.requestId)
  })

  it('logs agentId when set by downstream middleware', async () => {
    app.use('/v2/*', async (c, next) => {
      c.set('agentId', 'agent-123')
      return next()
    })
    app.get('/v2/test', (c) => c.json({ ok: true }))

    await app.request('/v2/test')

    const logged = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect(logged.agentId).toBe('agent-123')
  })
})
