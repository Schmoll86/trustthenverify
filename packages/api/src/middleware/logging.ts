/**
 * Structured logging + error boundary middleware.
 * Runs as outermost middleware (before auth).
 *
 * Generates requestId, wraps next() with timing, catches unhandled errors.
 * Logs JSON to stdout — Workers captures for Logpush.
 * Integrates Toucan (Sentry SDK for Workers) for error tracking.
 */

import type { Context, Next } from 'hono'
import { Toucan } from 'toucan-js'

/** Initialize Sentry (Toucan) for the current request context. */
function initSentry(c: Context): Toucan | null {
  try {
    const dsn = (c.env as Record<string, unknown>)?.SENTRY_DSN as string | undefined
    if (!dsn) return null

    const sentry = new Toucan({
      dsn,
      context: c.executionCtx,
      request: c.req.raw,
    })

    sentry.setTag('service', 'trustthenverify-api')
    return sentry
  } catch {
    // Sentry init may fail in test environments where env/executionCtx aren't available
    return null
  }
}

export async function loggingMiddleware(c: Context, next: Next): Promise<void> {
  const requestId = crypto.randomUUID()
  c.set('requestId', requestId)

  const sentry = initSentry(c)
  if (sentry) {
    c.set('_sentry', sentry)
    sentry.setTag('requestId', requestId)
  }

  const start = Date.now()
  const method = c.req.method
  const path = c.req.path

  await next()

  const durationMs = Date.now() - start
  const status = c.res.status
  const agentId = c.get('agentId') as string | undefined

  if (sentry && agentId) {
    sentry.setUser({ id: agentId })
  }

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

  // Report to Sentry if available
  const sentry = c.get('_sentry') as Toucan | undefined
  if (sentry) {
    sentry.setExtra('requestId', requestId)
    sentry.setExtra('path', c.req.path)
    sentry.setExtra('method', c.req.method)
    sentry.captureException(err)
  }

  return c.json(
    {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      meta: { requestId },
    },
    500 as unknown as 200,
  )
}

/**
 * Capture a financial error to Sentry with fatal level.
 * Call from Stripe/on-chain services for money-related failures.
 */
export function captureFinancialError(
  sentry: Toucan | null | undefined,
  err: Error,
  context: Record<string, unknown>,
): void {
  if (!sentry) return
  sentry.setTag('financial', 'true')
  for (const [k, v] of Object.entries(context)) {
    sentry.setExtra(k, v)
  }
  sentry.captureException(err)
}
