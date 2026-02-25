import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockNostr } from './helpers/mock-nostr'

let mockDb: MockDb
const mockNostr = createMockNostr()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

// Use a real secp256k1 key for gateway signing
const gatewayKeypair = generateKeypair()

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: gatewayKeypair.privateKey,
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_123',
}

const authorKp = generateKeypair()
const subjectKp = generateKeypair()

function seedAgents() {
  mockDb.seedTable('agents', [
    {
      id: 'author-agent-id',
      public_key: authorKp.publicKey,
      endpoint: null,
      name: 'author',
      capabilities: [],
      metadata: {},
      parent_id: null,
      created_at: '2025-01-01T00:00:00Z',
      last_seen_at: '2025-01-01T00:00:00Z',
    },
    {
      id: 'subject-agent-id',
      public_key: subjectKp.publicKey,
      endpoint: null,
      name: 'subject',
      capabilities: [],
      metadata: {},
      parent_id: null,
      created_at: '2025-01-01T00:00:00Z',
      last_seen_at: '2025-01-01T00:00:00Z',
    },
  ])
}

async function makeSignedRequest(
  method: string,
  path: string,
  body: string,
  keypair: { publicKey: string; privateKey: string },
) {
  const timestamp = Math.floor(Date.now() / 1000)
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
  }, { ...env, __nostrService: mockNostr } as unknown as Record<string, unknown>)
}

async function makeSandboxRequest(method: string, path: string, body?: string) {
  return app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Sandbox-Key': 'test_sandbox_key_123',
    },
    body: method === 'GET' ? undefined : body,
  }, env)
}

describe('POST /v2/attestations', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    mockNostr.reset()
    seedAgents()
  })

  it('creates attestation with valid request -> 201', async () => {
    const body = JSON.stringify({
      subjectId: 'subject-agent-id',
      outcome: 'success',
      verificationMethod: 'automated_reasoning',
    })

    const res = await makeSignedRequest('POST', '/v2/attestations', body, authorKp)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.authorId).toBe('author-agent-id')
    expect(json.data.subjectId).toBe('subject-agent-id')
    expect(json.data.outcome).toBe('success')
    expect(json.data.verificationMethod).toBe('automated_reasoning')
    expect(json.data.signature).toBeTruthy()
    expect(json.data.id).toBeTruthy()
    expect(json.data.createdAt).toBeTruthy()
  })

  it('relay failure -> still returns 201 with nostrEventId: null', async () => {
    mockNostr.setShouldFail(true)

    const body = JSON.stringify({
      subjectId: 'subject-agent-id',
      outcome: 'failure',
    })

    const res = await makeSignedRequest('POST', '/v2/attestations', body, authorKp)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.nostrEventId).toBeNull()
  })

  it('401 without auth', async () => {
    const res = await app.request('/v2/attestations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectId: 'x', outcome: 'success' }),
    }, env)
    expect(res.status).toBe(401)
  })

  it('400 missing subjectId', async () => {
    const body = JSON.stringify({ outcome: 'success' })
    const res = await makeSignedRequest('POST', '/v2/attestations', body, authorKp)
    expect(res.status).toBe(400)

    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('MISSING_FIELD')
  })

  it('400 missing outcome', async () => {
    const body = JSON.stringify({ subjectId: 'subject-agent-id' })
    const res = await makeSignedRequest('POST', '/v2/attestations', body, authorKp)
    expect(res.status).toBe(400)

    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('MISSING_FIELD')
  })

  it('400 invalid outcome value', async () => {
    const body = JSON.stringify({ subjectId: 'subject-agent-id', outcome: 'bogus' })
    const res = await makeSignedRequest('POST', '/v2/attestations', body, authorKp)
    expect(res.status).toBe(400)

    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('INVALID_OUTCOME')
  })

  it('404 unknown subject agent', async () => {
    const body = JSON.stringify({ subjectId: 'nonexistent-id', outcome: 'success' })
    const res = await makeSignedRequest('POST', '/v2/attestations', body, authorKp)
    expect(res.status).toBe(404)
  })

  it('includes escrowId when provided', async () => {
    mockDb.seedTable('escrows', [{
      id: 'escrow-abc',
      buyer_id: 'author-agent-id',
      seller_id: 'subject-agent-id',
      amount_cents: 1000,
      status: 'released',
    }])

    const body = JSON.stringify({
      subjectId: 'subject-agent-id',
      escrowId: 'escrow-abc',
      outcome: 'success',
    })

    const res = await makeSignedRequest('POST', '/v2/attestations', body, authorKp)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.escrowId).toBe('escrow-abc')
  })

  it('supports all valid outcome values', async () => {
    for (const outcome of ['success', 'failure', 'timeout', 'partial']) {
      const body = JSON.stringify({ subjectId: 'subject-agent-id', outcome })
      const res = await makeSignedRequest('POST', '/v2/attestations', body, authorKp)
      expect(res.status).toBe(201)
    }
  })
})

describe('GET /v2/attestations/:pubkey', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    seedAgents()
  })

  it('returns attestations for pubkey ordered by date DESC', async () => {
    mockDb.seedTable('attestations', [
      {
        id: 'att-1',
        author_id: 'author-agent-id',
        subject_id: 'subject-agent-id',
        escrow_id: null,
        outcome: 'success',
        verification_method: null,
        signature: 'sig1',
        nostr_event_id: null,
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'att-2',
        author_id: 'author-agent-id',
        subject_id: 'subject-agent-id',
        escrow_id: null,
        outcome: 'failure',
        verification_method: null,
        signature: 'sig2',
        nostr_event_id: null,
        created_at: '2025-01-02T00:00:00Z',
      },
    ])

    const res = await makeSandboxRequest('GET', `/v2/attestations/${subjectKp.publicKey}`)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Array<Record<string, unknown>> }
    expect(json.data).toHaveLength(2)
    // Ordered DESC — newer first
    expect(json.data[0].id).toBe('att-2')
    expect(json.data[1].id).toBe('att-1')
  })

  it('returns empty array for unknown pubkey', async () => {
    const res = await makeSandboxRequest('GET', `/v2/attestations/${'ff'.repeat(33)}`)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: unknown[] }
    expect(json.data).toEqual([])
  })

  it('respects ?limit param', async () => {
    const attestations = Array.from({ length: 5 }, (_, i) => ({
      id: `att-${i}`,
      author_id: 'author-agent-id',
      subject_id: 'subject-agent-id',
      escrow_id: null,
      outcome: 'success',
      verification_method: null,
      signature: `sig${i}`,
      nostr_event_id: null,
      created_at: `2025-01-0${i + 1}T00:00:00Z`,
    }))
    mockDb.seedTable('attestations', attestations)

    const res = await makeSandboxRequest('GET', `/v2/attestations/${subjectKp.publicKey}?limit=2`)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: unknown[] }
    expect(json.data).toHaveLength(2)
  })
})
