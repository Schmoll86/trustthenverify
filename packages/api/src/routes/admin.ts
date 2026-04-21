/**
 * Admin-only routes.
 *
 * Mounted BEFORE authMiddleware in index.ts, outside the /v2/* scope.
 * GET requests bypass authMiddleware by design (middleware/auth.ts:28), so
 * each admin endpoint carries its own shared-secret guard via X-Admin-Secret.
 *
 * Rotation: `wrangler secret put ADMIN_SECRET` (sandbox + production).
 * No user-facing surface — this exists for Ryan to see what the oracle bleed
 * looks like while we decide whether to meter it externally.
 */

import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { error, success } from '../lib/response'

type AppEnv = {
  Bindings: Env
  Variables: Record<string, never>
}

export const admin = new Hono<AppEnv>()

function requireAdmin(c: { req: { header(name: string): string | undefined }; env: Env }): null | ReturnType<typeof error> {
  const expected = c.env.ADMIN_SECRET
  if (!expected) {
    return error(c as never, 503, 'UNAVAILABLE', 'Admin endpoint not configured (ADMIN_SECRET missing)')
  }
  const provided = c.req.header('X-Admin-Secret')
  if (!provided || provided !== expected) {
    return error(c as never, 401, 'UNAUTHORIZED', 'Invalid admin secret')
  }
  return null
}

interface DailyBucket {
  date: string
  translationCents: number
  arbitrationCents: number
}

function toIsoDate(ts: string | null | undefined): string | null {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
}

// GET /admin/costs — rolling per-day AI cost totals from OpenRouter capture.
admin.get('/costs', async (c) => {
  const denied = requireAdmin(c)
  if (denied) return denied

  const db = createDb(c.env)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  // Translation cost lives on `policies`; arbitration cost on `disputes`.
  // Supabase client has no native SUM aggregation — pull the raw rows (rate
  // is <1k/month until dogfood lands) and aggregate in JS.
  const [{ data: policyRows }, { data: disputeRows }] = await Promise.all([
    db.from('policies').select('created_at, ai_cost_cents').gt('ai_cost_cents', 0),
    db.from('disputes').select('resolved_at, ai_cost_cents').gt('ai_cost_cents', 0),
  ])

  let lifetimeTranslation = 0
  let lifetimeArbitration = 0
  const buckets: Record<string, DailyBucket> = {}

  const ensure = (date: string): DailyBucket => {
    if (!buckets[date]) buckets[date] = { date, translationCents: 0, arbitrationCents: 0 }
    return buckets[date]
  }

  for (const row of policyRows ?? []) {
    const cents = Number((row as { ai_cost_cents: number | null }).ai_cost_cents ?? 0)
    lifetimeTranslation += cents
    const createdAt = (row as { created_at?: string }).created_at
    const date = toIsoDate(createdAt)
    if (date && createdAt && createdAt >= thirtyDaysAgo) {
      ensure(date).translationCents += cents
    }
  }

  for (const row of disputeRows ?? []) {
    const cents = Number((row as { ai_cost_cents: number | null }).ai_cost_cents ?? 0)
    lifetimeArbitration += cents
    const resolvedAt = (row as { resolved_at?: string }).resolved_at
    const date = toIsoDate(resolvedAt)
    if (date && resolvedAt && resolvedAt >= thirtyDaysAgo) {
      ensure(date).arbitrationCents += cents
    }
  }

  const last30Days = Object.values(buckets).sort((a, b) => (a.date < b.date ? -1 : 1))

  return success(c, {
    lifetime: {
      translationCents: lifetimeTranslation,
      arbitrationCents: lifetimeArbitration,
      totalCents: lifetimeTranslation + lifetimeArbitration,
    },
    last30Days,
  })
})
