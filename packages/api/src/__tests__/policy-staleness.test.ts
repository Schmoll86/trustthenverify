/**
 * Tests for handlePolicyStaleness() cron — flags policies with >5% dispute rate as stale.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockDb, type MockDb } from './helpers/mock-db'

let mockDb: MockDb

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

import { handlePolicyStaleness } from '../cron/escrow-timeout'

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'test-gateway-key',
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_mock',
  QUEUE: { send: vi.fn() },
}

const recentDate = new Date().toISOString()

function seedPolicy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pol-1',
    name: 'Test Policy',
    description: 'test',
    intent: 'test',
    formal_spec: '{}',
    version: 1,
    status: 'active',
    visibility: 'public',
    billing: 'marketplace',
    billing_model: 'free',
    usage_count: 0,
    created_by: 'creator-1',
    created_at: recentDate,
    ...overrides,
  }
}

function seedEscrows(policyId: string, statuses: string[]) {
  return statuses.map((status, i) => ({
    id: `esc-${policyId}-${i}`,
    buyer_id: 'b',
    seller_id: 's',
    amount_cents: 1000,
    seller_collateral: 500,
    policy_id: policyId,
    status,
    created_at: recentDate,
    verification_method: 'automated_reasoning',
    dispute_resolution: 'burn',
  }))
}

describe('handlePolicyStaleness cron', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    ;(env.QUEUE.send as ReturnType<typeof vi.fn>).mockReset()
  })

  it('flags policy with 6% dispute rate (3/50) as stale', async () => {
    mockDb.seedTable('policies', [seedPolicy()])
    // 3 disputed + 47 released = 50 total, 6% dispute rate
    const escrows = [
      ...seedEscrows('pol-1', Array(3).fill('disputed')),
      ...seedEscrows('pol-1', Array(47).fill('released')),
    ]
    // Re-index IDs to avoid collisions
    escrows.forEach((e, i) => { e.id = `esc-${i}` })
    mockDb.seedTable('escrows', escrows)

    const result = await handlePolicyStaleness(env as unknown as Parameters<typeof handlePolicyStaleness>[0])
    expect(result.flagged).toBe(1)

    const policy = mockDb.getTable('policies').rows[0]
    expect(policy.status).toBe('stale')
  })

  it('does NOT flag policy with 4% dispute rate', async () => {
    mockDb.seedTable('policies', [seedPolicy()])
    // 2 disputed + 48 released = 50 total, 4% dispute rate
    const escrows = [
      ...seedEscrows('pol-1', Array(2).fill('disputed')),
      ...seedEscrows('pol-1', Array(48).fill('released')),
    ]
    escrows.forEach((e, i) => { e.id = `esc-${i}` })
    mockDb.seedTable('escrows', escrows)

    const result = await handlePolicyStaleness(env as unknown as Parameters<typeof handlePolicyStaleness>[0])
    expect(result.flagged).toBe(0)

    const policy = mockDb.getTable('policies').rows[0]
    expect(policy.status).toBe('active')
  })

  it('skips policies with fewer than 5 escrows (insufficient data)', async () => {
    mockDb.seedTable('policies', [seedPolicy()])
    // 2 disputed + 2 released = 4 total — below threshold
    const escrows = [
      ...seedEscrows('pol-1', ['disputed', 'disputed', 'released', 'released']),
    ]
    escrows.forEach((e, i) => { e.id = `esc-${i}` })
    mockDb.seedTable('escrows', escrows)

    const result = await handlePolicyStaleness(env as unknown as Parameters<typeof handlePolicyStaleness>[0])
    expect(result.flagged).toBe(0)
  })

  it('skips already-stale policies (only scans active)', async () => {
    mockDb.seedTable('policies', [seedPolicy({ status: 'stale' })])
    const escrows = seedEscrows('pol-1', Array(6).fill('disputed'))
    escrows.forEach((e, i) => { e.id = `esc-${i}` })
    mockDb.seedTable('escrows', escrows)

    const result = await handlePolicyStaleness(env as unknown as Parameters<typeof handlePolicyStaleness>[0])
    expect(result.flagged).toBe(0)
  })

  it('flags only the bad policy when multiple exist', async () => {
    mockDb.seedTable('policies', [
      seedPolicy({ id: 'pol-healthy' }),
      seedPolicy({ id: 'pol-bad' }),
    ])
    // Healthy: 0 disputed / 10 released = 0%
    const healthyEscrows = seedEscrows('pol-healthy', Array(10).fill('released'))
    healthyEscrows.forEach((e, i) => { e.id = `healthy-${i}` })
    // Bad: 4 disputed / 6 released = 4/10 = 40%
    const badEscrows = [
      ...seedEscrows('pol-bad', Array(4).fill('disputed')),
      ...seedEscrows('pol-bad', Array(6).fill('released')),
    ]
    badEscrows.forEach((e, i) => { e.id = `bad-${i}` })
    mockDb.seedTable('escrows', [...healthyEscrows, ...badEscrows])

    const result = await handlePolicyStaleness(env as unknown as Parameters<typeof handlePolicyStaleness>[0])
    expect(result.flagged).toBe(1)

    const policies = mockDb.getTable('policies').rows
    const healthy = policies.find(p => p.id === 'pol-healthy')
    const bad = policies.find(p => p.id === 'pol-bad')
    expect(healthy!.status).toBe('active')
    expect(bad!.status).toBe('stale')
  })

  it('enqueues notification with disputeRate, disputeCount, totalCount', async () => {
    mockDb.seedTable('policies', [seedPolicy({ created_by: 'agent-xyz' })])
    // 4 disputed + 6 released = 10, 40% rate
    const escrows = [
      ...seedEscrows('pol-1', Array(4).fill('disputed')),
      ...seedEscrows('pol-1', Array(6).fill('released')),
    ]
    escrows.forEach((e, i) => { e.id = `esc-${i}` })
    mockDb.seedTable('escrows', escrows)

    await handlePolicyStaleness(env as unknown as Parameters<typeof handlePolicyStaleness>[0])

    expect(env.QUEUE.send).toHaveBeenCalledWith({
      type: 'notification',
      agentId: 'agent-xyz',
      eventType: 'policy.stale',
      escrowId: 'pol-1',
      payload: {
        disputeRate: 40,
        disputeCount: 4,
        totalCount: 10,
      },
    })
  })

  it('skips draft and deprecated policies', async () => {
    mockDb.seedTable('policies', [
      seedPolicy({ id: 'pol-draft', status: 'draft' }),
      seedPolicy({ id: 'pol-deprecated', status: 'deprecated' }),
    ])
    const escrows = [
      ...seedEscrows('pol-draft', Array(6).fill('disputed')),
      ...seedEscrows('pol-deprecated', Array(6).fill('disputed')),
    ]
    escrows.forEach((e, i) => { e.id = `esc-${i}` })
    mockDb.seedTable('escrows', escrows)

    const result = await handlePolicyStaleness(env as unknown as Parameters<typeof handlePolicyStaleness>[0])
    expect(result.flagged).toBe(0)
  })

  it('exactly 5% is NOT flagged (code uses > 0.05, not >=)', async () => {
    mockDb.seedTable('policies', [seedPolicy()])
    // 1 disputed + 19 released = 20, exactly 5%
    const escrows = [
      ...seedEscrows('pol-1', ['disputed']),
      ...seedEscrows('pol-1', Array(19).fill('released')),
    ]
    escrows.forEach((e, i) => { e.id = `esc-${i}` })
    mockDb.seedTable('escrows', escrows)

    const result = await handlePolicyStaleness(env as unknown as Parameters<typeof handlePolicyStaleness>[0])
    expect(result.flagged).toBe(0)

    const policy = mockDb.getTable('policies').rows[0]
    expect(policy.status).toBe('active')
  })
})
