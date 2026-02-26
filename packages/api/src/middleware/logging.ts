/**
 * Structured logging + error boundary middleware.
 * Runs as outermost middleware (before auth).
 *
 * Generates requestId, wraps next() with timing, catches unhandled errors.
 * Logs JSON to stdout — Workers captures for Logpush.
 */

import type { Context, Next } from 'hono'

export async function loggingMiddleware(c: Context, next: Next): Promise<void> {
  const requestId = crypto.randomUUID()
  c.set('requestId', requestId)

  const start = Date.now()
  const method = c.req.method
  const path = c.req.path

  await next()

  const durationMs = Date.now() - start
  const status = c.res.status
  const agentId = c.get('agentId') as string | undefined

  // Check if the response is an error (set by onError handler)
  const errorMsg = c.get('_errorMessage') as string | undefined

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    requestId,
    method,
    path,
    status,
    agentId: agentId ?? null,
    durationMs,
    ...(errorMsg ? { error: errorMsg } : {}),
  }))
}

/**
 * Hono onError handler — catches unhandled errors, returns 500 envelope.
 * Must be registered via app.onError().
 */
export function errorHandler(err: Error, c: Context): Response {
  const requestId = c.get('requestId') as string | undefined ?? crypto.randomUUID()

  // Store error message for logging middleware to pick up
  c.set('_errorMessage', err.message)

  return c.json(
    {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      meta: { requestId },
    },
    500 as unknown as 200,
  )
}
