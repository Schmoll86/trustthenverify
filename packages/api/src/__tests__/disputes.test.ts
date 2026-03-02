import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { makeSignedRequest } from './helpers/signed-request'
import { generateKeypair } from '@trustthenverify/sdk'

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

describe('GET /v2/disputes/:id', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('returns dispute with camelCase keys', async () => {
    mockDb.seedTable('disputes', [{
      id: 'disp-1',
      escrow_id: 'escrow-1',
      initiator_id: 'agent-1',
      reason: 'Deliverable incomplete',
      evidence_hash: 'abc123',
      ruling: 'buyer_wins',
      status: 'resolved',
      created_at: '2026-01-01T12:00:00Z',
    }])

    const res = await app.request('/v2/disputes/disp-1', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.escrowId).toBe('escrow-1')
    expect(json.data.initiatorId).toBe('agent-1')
    expect(json.data.ruling).toBe('buyer_wins')
  })

  it('returns 404 for nonexistent dispute', async () => {
    mockDb.seedTable('disputes', [])

    const res = await app.request('/v2/disputes/nonexistent', { method: 'GET' }, env)
    expect(res.status).toBe(404)

    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('NOT_FOUND')
  })

  it('parses JSON evidence_hash into arbitrationDetails', async () => {
    mockDb.seedTable('disputes', [{
      id: 'disp-2',
      escrow_id: 'escrow-2',
      initiator_id: 'agent-1',
      reason: 'Bad quality',
      evidence_hash: '{"rationale":"test reasoning","confidence":0.9,"fee":500}',
      ruling: 'seller_wins',
      status: 'resolved',
      created_at: '2026-01-01T12:00:00Z',
    }])

    const res = await app.request('/v2/disputes/disp-2', { method: 'GET' }, env)
    const json = await res.json() as { data: Record<string, unknown> }

    expect(json.data.arbitrationDetails).toBeDefined()
    const details = json.data.arbitrationDetails as { rationale: string; confidence: number; fee: number }
    expect(details.rationale).toBe('test reasoning')
    expect(details.confidence).toBe(0.9)
    expect(details.fee).toBe(500)
  })

  it('leaves non-JSON evidence_hash as-is', async () => {
    mockDb.seedTable('disputes', [{
      id: 'disp-3',
      escrow_id: 'escrow-3',
      initiator_id: 'agent-1',
      reason: 'Timeout',
      evidence_hash: 'plain-text-hash-abc123',
      ruling: null,
      status: 'pending',
      created_at: '2026-01-01T12:00:00Z',
    }])

    const res = await app.request('/v2/disputes/disp-3', { method: 'GET' }, env)
    const json = await res.json() as { data: Record<string, unknown> }

    // evidence_hash doesn't start with '{', so no arbitrationDetails
    expect(json.data.arbitrationDetails).toBeUndefined()
    expect(json.data.evidenceHash).toBe('plain-text-hash-abc123')
  })

  it('handles null evidence_hash gracefully', async () => {
    mockDb.seedTable('disputes', [{
      id: 'disp-4',
      escrow_id: 'escrow-4',
      initiator_id: 'agent-1',
      reason: 'Missing deliverable',
      evidence_hash: null,
      ruling: null,
      status: 'pending',
      created_at: '2026-01-01T12:00:00Z',
    }])

    const res = await app.request('/v2/disputes/disp-4', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.arbitrationDetails).toBeUndefined()
  })
})

describe('POST /v2/disputes/:id/ruling', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('always returns 403 FORBIDDEN', async () => {
    const keypair = generateKeypair()
    mockDb.seedTable('agents', [{
      id: 'agent-1',
      public_key: keypair.publicKey,
      name: 'Test Agent',
      capabilities: [],
      endpoint: null,
    }])

    const res = await makeSignedRequest(
      'POST',
      '/v2/disputes/disp-1/ruling',
      JSON.stringify({ ruling: 'buyer_wins' }),
      keypair,
    )

    expect(res.status).toBe(403)
    const json = await res.json() as { error: { code: string; message: string } }
    expect(json.error.code).toBe('FORBIDDEN')
  })

  it('returns 403 even with valid auth', async () => {
    const keypair = generateKeypair()
    mockDb.seedTable('agents', [{
      id: 'agent-1',
      public_key: keypair.publicKey,
      name: 'Authorized Agent',
      capabilities: ['arbitration'],
      endpoint: null,
    }])

    const res = await makeSignedRequest(
      'POST',
      '/v2/disputes/disp-1/ruling',
      JSON.stringify({ ruling: 'seller_wins' }),
      keypair,
    )

    expect(res.status).toBe(403)
  })

  it('includes correct error message about automated arbitration', async () => {
    const keypair = generateKeypair()
    mockDb.seedTable('agents', [{
      id: 'agent-1',
      public_key: keypair.publicKey,
      name: 'Test Agent',
      capabilities: [],
      endpoint: null,
    }])

    const res = await makeSignedRequest(
      'POST',
      '/v2/disputes/disp-1/ruling',
      JSON.stringify({ ruling: 'buyer_wins' }),
      keypair,
    )

    const json = await res.json() as { error: { message: string } }
    expect(json.error.message).toContain('automated')
  })
})
