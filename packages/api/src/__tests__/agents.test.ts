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
