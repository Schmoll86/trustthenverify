/**
 * Tests for attestation queries feeding suggestCollateral —
 * API-side query behavior + SDK-level collateral suggestion integration.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest, TrustProtocol } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'

let mockDb: MockDb

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

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
      email: null,
      notification_preferences: null,
      webhook_url: null,
      webhook_secret: null,
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
      email: null,
      notification_preferences: null,
      webhook_url: null,
      webhook_secret: null,
    },
  ])
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
  }, env)
}

function makeAttestationRows(outcomes: string[]) {
  return outcomes.map((outcome, i) => ({
    id: `att-${i}`,
    author_id: 'author-agent-id',
    subject_id: 'subject-agent-id',
    escrow_id: null,
    outcome,
    verification_method: 'automated_reasoning',
    signature: `sig-${i}`,
    nostr_event_id: null,
    created_at: `2025-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  }))
}

// ── API attestation query tests ─────────────────────────────────────────

describe('Attestation API queries for collateral', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    seedAgents()
  })

  it('no attestations -> returns empty array', async () => {
    mockDb.seedTable('attestations', [])
    const res = await makeSandboxRequest('GET', `/v2/attestations/${subjectKp.publicKey}`)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: unknown[] }
    expect(json.data).toEqual([])
  })

  it('10/10 success attestations returned in DESC order', async () => {
    const attestations = makeAttestationRows(Array(10).fill('success'))
    mockDb.seedTable('attestations', attestations)

    const res = await makeSandboxRequest('GET', `/v2/attestations/${subjectKp.publicKey}`)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Array<{ outcome: string; id: string }> }
    expect(json.data).toHaveLength(10)
    // All success
    json.data.forEach(a => expect(a.outcome).toBe('success'))
    // DESC order: att-9 (Jan 10) before att-0 (Jan 1)
    expect(json.data[0].id).toBe('att-9')
  })

  it('mixed outcomes returned correctly', async () => {
    const attestations = makeAttestationRows(['success', 'failure', 'success', 'success', 'failure'])
    mockDb.seedTable('attestations', attestations)

    const res = await makeSandboxRequest('GET', `/v2/attestations/${subjectKp.publicKey}`)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Array<{ outcome: string }> }
    const outcomes = json.data.map(a => a.outcome)
    expect(outcomes.filter(o => o === 'success')).toHaveLength(3)
    expect(outcomes.filter(o => o === 'failure')).toHaveLength(2)
  })

  it('limit parameter caps returned attestations', async () => {
    const attestations = makeAttestationRows(Array(15).fill('success'))
    mockDb.seedTable('attestations', attestations)

    const res = await makeSandboxRequest('GET', `/v2/attestations/${subjectKp.publicKey}?limit=5`)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: unknown[] }
    expect(json.data).toHaveLength(5)
  })

  it('all failures returned for a distrusted agent', async () => {
    const attestations = makeAttestationRows(Array(8).fill('failure'))
    mockDb.seedTable('attestations', attestations)

    const res = await makeSandboxRequest('GET', `/v2/attestations/${subjectKp.publicKey}`)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Array<{ outcome: string }> }
    expect(json.data).toHaveLength(8)
    json.data.forEach(a => expect(a.outcome).toBe('failure'))
  })
})

// ── SDK suggestCollateral integration ───────────────────────────────────

describe('SDK suggestCollateral integration', () => {
  const mockFetch = vi.fn()
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = mockFetch
    mockFetch.mockReset()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('no attestations -> suggestedRatio 0.5, confidence low, dataPoints 0', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    })

    const kp = generateKeypair()
    const protocol = new TrustProtocol({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      apiUrl: 'http://test-api',
    })
    const result = await protocol.suggestCollateral('aa'.repeat(33), 10000)

    expect(result).toEqual({ suggestedRatio: 0.5, confidence: 'low', dataPoints: 0 })
  })

  it('20+ attestations -> high confidence', async () => {
    const attestations = Array(25).fill(null).map((_, i) => ({
      id: `att-${i}`,
      authorId: 'a',
      subjectId: 's',
      escrowId: null,
      outcome: 'success',
      verificationMethod: null,
      signature: 'sig',
      nostrEventId: null,
      createdAt: new Date().toISOString(),
    }))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: attestations }),
    })

    const kp = generateKeypair()
    const protocol = new TrustProtocol({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      apiUrl: 'http://test-api',
    })
    const result = await protocol.suggestCollateral('bb'.repeat(33), 10000)

    expect(result.confidence).toBe('high')
    expect(result.dataPoints).toBe(25)
    // High trust -> low ratio
    expect(result.suggestedRatio).toBeLessThan(0.3)
  })

  it('remote fetch failure -> graceful fallback to local-only', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const kp = generateKeypair()
    const protocol = new TrustProtocol({
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      apiUrl: 'http://test-api',
    })
    const pubkey = 'cc'.repeat(33)

    // Record local observations
    for (let i = 0; i < 4; i++) {
      protocol.recordObservation(pubkey, { outcome: 'success' })
    }

    const result = await protocol.suggestCollateral(pubkey, 10000)

    // Should work with local data only, not throw
    expect(result.dataPoints).toBe(4)
    expect(result.suggestedRatio).toBeLessThan(0.4)
    expect(result.confidence).toBe('low')
  })
})
