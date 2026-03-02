import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'

let mockDb: MockDb

// Mock the Supabase client
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'test-gateway-key',
  SANDBOX_KEYS: 'test_sandbox_key_123',
}

async function makeSignedRequest(
  method: string,
  path: string,
  body: string,
  keypair: { publicKey: string; privateKey: string },
) {
  const timestamp = Math.floor(Date.now() / 1000)
  // The auth middleware strips /v2 prefix before building canonical string
  const sigPath = path.replace('/v2', '')
  const signature = await signRequest(keypair.privateKey, method, sigPath, body, timestamp)
  return app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Pubkey': keypair.publicKey,
      'X-Agent-Timestamp': String(timestamp),
      'X-Agent-Signature': signature,
    },
    body: method === 'GET' ? undefined : body,
  }, env)
}

describe('POST /v2/agents — register', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('registers an agent with valid self-signed request → 201', async () => {
    const kp = generateKeypair()
    const body = JSON.stringify({
      publicKey: kp.publicKey,
      name: 'test-agent',
      capabilities: ['web-search'],
    })

    const res = await makeSignedRequest('POST', '/v2/agents', body, kp)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: { publicKey: string; name: string } }
    expect(json.data.publicKey).toBe(kp.publicKey)
    expect(json.data.name).toBe('test-agent')
  })

  it('rejects invalid signature → 401', async () => {
    const kp = generateKeypair()
    const otherKp = generateKeypair()
    const body = JSON.stringify({ publicKey: kp.publicKey })

    // Sign with wrong key
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = await signRequest(otherKp.privateKey, 'POST', '/agents', body, timestamp)

    const res = await app.request('/v2/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Pubkey': kp.publicKey,
        'X-Agent-Timestamp': String(timestamp),
        'X-Agent-Signature': signature,
      },
      body,
    }, env)

    expect(res.status).toBe(401)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('SIGNATURE_INVALID')
  })

  it('rejects duplicate pubkey → 409', async () => {
    const kp = generateKeypair()
    mockDb.seedTable('agents', [{ public_key: kp.publicKey, id: 'existing-id' }])

    const body = JSON.stringify({ publicKey: kp.publicKey })
    const res = await makeSignedRequest('POST', '/v2/agents', body, kp)
    expect(res.status).toBe(409)
  })

  it('sandbox auth bypasses ECDSA', async () => {
    const kp = generateKeypair()
    const body = JSON.stringify({
      publicKey: kp.publicKey,
      name: 'sandbox-agent',
      capabilities: [],
    })

    const res = await app.request('/v2/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sandbox-Key': 'test_sandbox_key_123',
      },
      body,
    }, env)

    expect(res.status).toBe(201)
  })
})

describe('GET /v2/agents/:pubkey — lookup', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('returns agent when found', async () => {
    const kp = generateKeypair()
    mockDb.seedTable('agents', [{
      id: 'agent-1',
      public_key: kp.publicKey,
      endpoint: null,
      name: 'test',
      capabilities: ['web-search'],
      metadata: {},
      parent_id: null,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    }])

    const res = await app.request(`/v2/agents/${kp.publicKey}`, { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { publicKey: string } }
    expect(json.data.publicKey).toBe(kp.publicKey)
  })

  it('returns 404 when not found', async () => {
    const res = await app.request('/v2/agents/nonexistent', { method: 'GET' }, env)
    expect(res.status).toBe(404)
  })
})

describe('GET /v2/agents/search — search', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    mockDb.seedTable('agents', [
      {
        id: 'a1', public_key: 'pk1', name: 'Agent1',
        capabilities: ['web-search', 'summarization'],
        metadata: {}, parent_id: null, endpoint: null,
        created_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'a2', public_key: 'pk2', name: 'Agent2',
        capabilities: ['translation'],
        metadata: {}, parent_id: null, endpoint: null,
        created_at: '2026-01-02T00:00:00Z', last_seen_at: '2026-01-02T00:00:00Z',
      },
    ])
  })

  it('returns agents matching capability (any)', async () => {
    const res = await app.request('/v2/agents/search?capabilities=web-search', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Array<{ name: string }> }
    expect(json.data.length).toBeGreaterThanOrEqual(1)
  })

  it('requires capabilities parameter', async () => {
    const res = await app.request('/v2/agents/search', { method: 'GET' }, env)
    expect(res.status).toBe(400)
  })
})

describe('GET /v2/agents/:pubkey/escrows — list escrows', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    mockDb.seedTable('agents', [{
      id: 'agent-buyer',
      public_key: 'pk_buyer_test',
      endpoint: null,
      name: 'Buyer Agent',
      capabilities: [],
      metadata: {},
      parent_id: null,
      created_at: '2026-01-01T00:00:00Z',
      last_seen_at: '2026-01-01T00:00:00Z',
    }])
    mockDb.seedTable('escrows', [
      {
        id: 'e1', buyer_id: 'agent-buyer', seller_id: 'other-seller',
        status: 'active', amount_cents: 5000, created_at: '2026-02-01T00:00:00Z',
      },
      {
        id: 'e2', buyer_id: 'other-buyer', seller_id: 'agent-buyer',
        status: 'completed', amount_cents: 3000, created_at: '2026-02-02T00:00:00Z',
      },
      {
        id: 'e3', buyer_id: 'other-buyer', seller_id: 'other-seller',
        status: 'active', amount_cents: 1000, created_at: '2026-02-03T00:00:00Z',
      },
    ])
  })

  it('returns escrows where agent is buyer or seller', async () => {
    const res = await app.request('/v2/agents/pk_buyer_test/escrows', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Array<{ id: string }>; meta: { count: number } }
    expect(json.data.length).toBe(2)
    expect(json.meta.count).toBe(2)
  })

  it('filters by role=buyer', async () => {
    const res = await app.request('/v2/agents/pk_buyer_test/escrows?role=buyer', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Array<{ id: string }> }
    expect(json.data.length).toBe(1)
    expect(json.data[0].id).toBe('e1')
  })

  it('filters by role=seller', async () => {
    const res = await app.request('/v2/agents/pk_buyer_test/escrows?role=seller', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Array<{ id: string }> }
    expect(json.data.length).toBe(1)
    expect(json.data[0].id).toBe('e2')
  })

  it('filters by status', async () => {
    const res = await app.request('/v2/agents/pk_buyer_test/escrows?status=active', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Array<{ id: string }> }
    expect(json.data.length).toBeGreaterThanOrEqual(1)
    // Should only include active escrows involving this agent
    for (const escrow of json.data) {
      expect(escrow.id).not.toBe('e2') // e2 is completed
    }
  })

  it('returns 404 for unknown pubkey', async () => {
    const res = await app.request('/v2/agents/unknown_pubkey/escrows', { method: 'GET' }, env)
    expect(res.status).toBe(404)
  })

  it('returns empty array when no escrows', async () => {
    mockDb.seedTable('agents', [{
      id: 'agent-lonely',
      public_key: 'pk_lonely',
      endpoint: null, name: 'Lonely', capabilities: [], metadata: {},
      parent_id: null,
      created_at: '2026-01-01T00:00:00Z',
      last_seen_at: '2026-01-01T00:00:00Z',
    }])

    const res = await app.request('/v2/agents/pk_lonely/escrows', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: unknown[]; meta: { count: number } }
    expect(json.data).toEqual([])
    expect(json.meta.count).toBe(0)
  })
})

describe('POST /v2/agents/:pubkey/verify', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('returns verified: true for authenticated agent', async () => {
    const kp = generateKeypair()
    mockDb.seedTable('agents', [{ id: 'a1', public_key: kp.publicKey }])

    const res = await makeSignedRequest('POST', `/v2/agents/${kp.publicKey}/verify`, '{}', kp)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { verified: boolean } }
    expect(json.data.verified).toBe(true)
  })
})

describe('POST /v2/agents/:pubkey/spawn', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('spawns child agent with parentId set', async () => {
    const parentKp = generateKeypair()
    const childKp = generateKeypair()
    mockDb.seedTable('agents', [{
      id: 'parent-id',
      public_key: parentKp.publicKey,
      endpoint: null, name: 'parent',
      capabilities: [], metadata: {},
      parent_id: null,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    }])

    const body = JSON.stringify({
      publicKey: childKp.publicKey,
      name: 'child-agent',
      capabilities: ['web-search'],
    })

    const res = await makeSignedRequest('POST', `/v2/agents/${parentKp.publicKey}/spawn`, body, parentKp)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: { parentId: string; name: string } }
    expect(json.data.parentId).toBe('parent-id')
    expect(json.data.name).toBe('child-agent')
  })

  it('rejects spawning children of another agent', async () => {
    const callerKp = generateKeypair()
    const otherKp = generateKeypair()
    mockDb.seedTable('agents', [
      { id: 'caller-id', public_key: callerKp.publicKey },
      { id: 'other-id', public_key: otherKp.publicKey },
    ])

    const childKp = generateKeypair()
    const body = JSON.stringify({ publicKey: childKp.publicKey })

    const res = await makeSignedRequest('POST', `/v2/agents/${otherKp.publicKey}/spawn`, body, callerKp)
    expect(res.status).toBe(403)
  })
})

describe('GET /v2/agents/stats/batch — batch stats', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    mockDb.seedTable('agents', [
      { id: 'a1', public_key: 'pk_alpha', name: 'Alpha', capabilities: [], metadata: {}, parent_id: null, endpoint: null, created_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-01-01T00:00:00Z' },
      { id: 'a2', public_key: 'pk_beta', name: 'Beta', capabilities: [], metadata: {}, parent_id: null, endpoint: null, created_at: '2026-01-02T00:00:00Z', last_seen_at: '2026-01-02T00:00:00Z' },
    ])
    mockDb.seedTable('escrows', [
      { id: 'e1', buyer_id: 'a1', seller_id: 'a2', status: 'released', amount_cents: 5000, created_at: '2026-02-01T00:00:00Z' },
      { id: 'e2', buyer_id: 'a1', seller_id: 'a2', status: 'failed', amount_cents: 2000, created_at: '2026-02-02T00:00:00Z' },
      { id: 'e3', buyer_id: 'a1', seller_id: 'a2', status: 'released', amount_cents: 3000, created_at: '2026-02-03T00:00:00Z' },
    ])
  })

  it('returns stats for multiple agents', async () => {
    const res = await app.request('/v2/agents/stats/batch?pubkeys=pk_alpha,pk_beta', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Record<string, { totalEscrows: number; released: number; successRate: number | null; totalValueCents: number }> }
    expect(json.data.pk_alpha).toBeDefined()
    expect(json.data.pk_beta).toBeDefined()
    expect(json.data.pk_alpha.totalEscrows).toBe(3)
    expect(json.data.pk_alpha.released).toBe(2)
    expect(json.data.pk_alpha.successRate).toBe(67)
    expect(json.data.pk_alpha.totalValueCents).toBe(8000)
  })

  it('returns empty object for unknown pubkeys', async () => {
    const res = await app.request('/v2/agents/stats/batch?pubkeys=pk_unknown', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Record<string, unknown> }
    expect(Object.keys(json.data)).toHaveLength(0)
  })

  it('requires pubkeys parameter', async () => {
    const res = await app.request('/v2/agents/stats/batch', { method: 'GET' }, env)
    expect(res.status).toBe(400)
  })

  it('limits to 20 pubkeys', async () => {
    const keys = Array.from({ length: 25 }, (_, i) => `pk_${i}`).join(',')
    const res = await app.request(`/v2/agents/stats/batch?pubkeys=${keys}`, { method: 'GET' }, env)
    expect(res.status).toBe(200)
    // Should not error, just silently truncate
  })
})

describe('Replay protection', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('rejects timestamp >30s old', async () => {
    const kp = generateKeypair()
    const body = JSON.stringify({ publicKey: kp.publicKey })
    const oldTimestamp = Math.floor(Date.now() / 1000) - 60

    const signature = await signRequest(kp.privateKey, 'POST', '/agents', body, oldTimestamp)

    const res = await app.request('/v2/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Pubkey': kp.publicKey,
        'X-Agent-Timestamp': String(oldTimestamp),
        'X-Agent-Signature': signature,
      },
      body,
    }, env)

    expect(res.status).toBe(401)
    const json = await res.json() as { error: { message: string } }
    expect(json.error.message).toContain('timestamp')
  })
})
