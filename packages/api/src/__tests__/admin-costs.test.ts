/**
 * Tests the GET /admin/costs endpoint: shared-secret guard and aggregation
 * of ai_cost_cents from policies (translation) + disputes (arbitration).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { createMockDb, type MockDb } from './helpers/mock-db'

let mockDb: MockDb

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'test-gateway-key',
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_mock',
  ADMIN_SECRET: 's3cret',
} as const

beforeEach(() => {
  mockDb = createMockDb()
})

function seedCosts() {
  const today = new Date().toISOString()
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()

  mockDb.seedTable('policies', [
    { id: 'p1', created_at: today, ai_cost_cents: 42 },
    { id: 'p2', created_at: yesterday, ai_cost_cents: 8 },
    { id: 'p3', created_at: fortyDaysAgo, ai_cost_cents: 100 }, // outside 30d window
    { id: 'p4', created_at: today, ai_cost_cents: 0 }, // excluded by gt(0)
  ])

  mockDb.seedTable('disputes', [
    { id: 'd1', resolved_at: today, ai_cost_cents: 17 },
    { id: 'd2', resolved_at: yesterday, ai_cost_cents: 3 },
    { id: 'd3', resolved_at: fortyDaysAgo, ai_cost_cents: 5 },
  ])
}

describe('GET /admin/costs — auth', () => {
  it('rejects requests without X-Admin-Secret', async () => {
    seedCosts()
    const res = await app.request('/admin/costs', { method: 'GET' }, env)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('rejects requests with wrong secret', async () => {
    seedCosts()
    const res = await app.request(
      '/admin/costs',
      { method: 'GET', headers: { 'X-Admin-Secret': 'wrong' } },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('returns 503 when ADMIN_SECRET is unset on the Worker', async () => {
    seedCosts()
    const envNoSecret = { ...env, ADMIN_SECRET: undefined }
    const res = await app.request(
      '/admin/costs',
      { method: 'GET', headers: { 'X-Admin-Secret': 's3cret' } },
      envNoSecret,
    )
    expect(res.status).toBe(503)
  })
})

describe('GET /admin/costs — aggregation', () => {
  it('aggregates lifetime totals across policies + disputes', async () => {
    seedCosts()
    const res = await app.request(
      '/admin/costs',
      { method: 'GET', headers: { 'X-Admin-Secret': 's3cret' } },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as {
      data: {
        lifetime: { translationCents: number; arbitrationCents: number; totalCents: number }
        last30Days: Array<{ date: string; translationCents: number; arbitrationCents: number }>
      }
    }

    // Lifetime includes the 40-day-old rows; last30Days excludes them.
    expect(body.data.lifetime.translationCents).toBe(42 + 8 + 100)
    expect(body.data.lifetime.arbitrationCents).toBe(17 + 3 + 5)
    expect(body.data.lifetime.totalCents).toBe(42 + 8 + 100 + 17 + 3 + 5)
  })

  it('buckets last 30 days by date', async () => {
    seedCosts()
    const res = await app.request(
      '/admin/costs',
      { method: 'GET', headers: { 'X-Admin-Secret': 's3cret' } },
      env,
    )
    const body = await res.json() as {
      data: { last30Days: Array<{ date: string; translationCents: number; arbitrationCents: number }> }
    }

    // Two active days (today + yesterday); fortyDaysAgo row excluded.
    expect(body.data.last30Days).toHaveLength(2)
    const totalIn30 = body.data.last30Days.reduce(
      (s, d) => s + d.translationCents + d.arbitrationCents,
      0,
    )
    expect(totalIn30).toBe(42 + 8 + 17 + 3)

    // Sort order: ascending by date
    const dates = body.data.last30Days.map(d => d.date)
    const sorted = [...dates].sort()
    expect(dates).toEqual(sorted)
  })

  it('returns zero-state cleanly when no cost data exists', async () => {
    mockDb.seedTable('policies', [])
    mockDb.seedTable('disputes', [])

    const res = await app.request(
      '/admin/costs',
      { method: 'GET', headers: { 'X-Admin-Secret': 's3cret' } },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as {
      data: {
        lifetime: { totalCents: number }
        last30Days: unknown[]
      }
    }
    expect(body.data.lifetime.totalCents).toBe(0)
    expect(body.data.last30Days).toEqual([])
  })
})
