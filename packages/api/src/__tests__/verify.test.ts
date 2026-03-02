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
}

describe('GET /v2/verify/:escrow_id', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('returns latest verification result with camelCase keys', async () => {
    mockDb.seedTable('verifications', [{
      id: 'ver-1',
      escrow_id: 'escrow-1',
      method: 'automated_reasoning',
      result: 'pass',
      constraints_total: 5,
      constraints_passed: 5,
      gateway_signature: 'sig-abc',
      verified_at: '2026-01-01T12:00:00Z',
    }])

    const res = await app.request('/v2/verify/escrow-1', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.escrowId).toBe('escrow-1')
    expect(json.data.method).toBe('automated_reasoning')
    expect(json.data.result).toBe('pass')
    expect(json.data.constraintsTotal).toBe(5)
    expect(json.data.constraintsPassed).toBe(5)
    expect(json.data.gatewaySignature).toBe('sig-abc')
  })

  it('returns 404 when no verifications exist for escrow', async () => {
    mockDb.seedTable('verifications', [])

    const res = await app.request('/v2/verify/nonexistent', { method: 'GET' }, env)
    expect(res.status).toBe(404)

    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('NOT_FOUND')
  })

  it('returns most recent when multiple exist (ordered by verified_at desc)', async () => {
    mockDb.seedTable('verifications', [
      {
        id: 'ver-old',
        escrow_id: 'escrow-1',
        method: 'hash_match',
        result: 'fail',
        constraints_total: 3,
        constraints_passed: 1,
        gateway_signature: 'sig-old',
        verified_at: '2026-01-01T10:00:00Z',
      },
      {
        id: 'ver-new',
        escrow_id: 'escrow-1',
        method: 'automated_reasoning',
        result: 'pass',
        constraints_total: 3,
        constraints_passed: 3,
        gateway_signature: 'sig-new',
        verified_at: '2026-01-01T14:00:00Z',
      },
    ])

    const res = await app.request('/v2/verify/escrow-1', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Record<string, unknown> }
    // Should return the newer one (ver-new has later verified_at)
    expect(json.data.id).toBe('ver-new')
    expect(json.data.result).toBe('pass')
  })

  it('returns all expected fields: id, escrowId, method, result', async () => {
    mockDb.seedTable('verifications', [{
      id: 'ver-1',
      escrow_id: 'escrow-1',
      method: 'buyer_confirm',
      result: 'pass',
      constraints_total: 0,
      constraints_passed: 0,
      gateway_signature: 'sig-1',
      verified_at: '2026-01-01T12:00:00Z',
    }])

    const res = await app.request('/v2/verify/escrow-1', { method: 'GET' }, env)
    const json = await res.json() as { data: Record<string, unknown> }

    expect(json.data).toHaveProperty('id')
    expect(json.data).toHaveProperty('escrowId')
    expect(json.data).toHaveProperty('method')
    expect(json.data).toHaveProperty('result')
    expect(json.data).toHaveProperty('verifiedAt')
  })

  it('handles empty data gracefully -> 404', async () => {
    // No verifications table seeded at all
    const res = await app.request('/v2/verify/anything', { method: 'GET' }, env)
    expect(res.status).toBe(404)
  })
})
