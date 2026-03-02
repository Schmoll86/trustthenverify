import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockQueue } from './helpers/mock-queue'

let mockDb: MockDb
const mockQueue = createMockQueue()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'test-gateway-key',
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_mock',
  AI: {},
  QUEUE: mockQueue,
}

const validFormalSpec = {
  version: 1,
  constraints: [
    { id: 'c1', type: 'exists', target: '$.results', params: {} },
  ],
}

function makePolicyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'policy-1',
    name: 'test-policy',
    description: null,
    intent: 'Return valid search results',
    formal_spec: validFormalSpec,
    version: 1,
    status: 'validated',
    billing: 'creator',
    tier2_used: false,
    translation_model: null,
    cross_validator: null,
    cross_validation: null,
    argus_budget: null,
    argus_coverage: null,
    argus_exploits: null,
    parent_version: null,
    created_by: 'agent-1',
    created_at: new Date().toISOString(),
    activated_at: null,
    deprecated_at: null,
    ...overrides,
  }
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

function seedAgent(keypair: { publicKey: string }) {
  mockDb.seedTable('agents', [{
    id: 'agent-1',
    public_key: keypair.publicKey,
    endpoint: null,
    name: 'creator',
    capabilities: [],
    metadata: {},
    parent_id: null,
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    email: null,
    notification_preferences: null,
    webhook_url: null,
    webhook_secret: null,
  }])
}

describe('POST /v2/policies/:id/refine', () => {
  let creator: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    mockQueue.reset()
    creator = generateKeypair()
    seedAgent(creator)
    mockDb.seedTable('refinements', [])
  })

  it('creates refinement and enqueues first batch', async () => {
    mockDb.seedTable('policies', [makePolicyRow()])

    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/refine', '{}', creator)
    expect(res.status).toBe(202)

    const json = await res.json() as { data: { refinementId: string; status: string } }
    expect(json.data.status).toBe('running')
    expect(json.data.refinementId).toBeTruthy()

    // Check refinement row created
    const refinements = mockDb.getTable('refinements').rows
    expect(refinements).toHaveLength(1)
    expect(refinements[0].status).toBe('running')
    expect(refinements[0].policy_id).toBe('policy-1')

    // Check queue message sent
    expect(mockQueue.messages).toHaveLength(1)
    expect((mockQueue.messages[0].body as Record<string, unknown>).type).toBe('argus_refine')
  })

  it('accepts custom budget', async () => {
    mockDb.seedTable('policies', [makePolicyRow()])

    const body = JSON.stringify({ budget: 500 })
    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/refine', body, creator)
    expect(res.status).toBe(202)

    const refinements = mockDb.getTable('refinements').rows
    expect(refinements[0].budget).toBe(500)
  })

  it('rejects if policy not validated', async () => {
    mockDb.seedTable('policies', [makePolicyRow({ status: 'draft' })])

    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/refine', '{}', creator)
    expect(res.status).toBe(409)

    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('INVALID_STATE')
  })

  it('rejects if not policy creator', async () => {
    const other = generateKeypair()
    mockDb.getTable('agents').rows.push({
      id: 'agent-2',
      public_key: other.publicKey,
      endpoint: null,
      name: 'other',
      capabilities: [],
      metadata: {},
      parent_id: null,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    })

    mockDb.seedTable('policies', [makePolicyRow()])

    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/refine', '{}', other)
    expect(res.status).toBe(403)
  })

  it('rejects if refinement already running', async () => {
    mockDb.seedTable('policies', [makePolicyRow()])
    mockDb.seedTable('refinements', [{
      id: 'ref-existing',
      policy_id: 'policy-1',
      status: 'running',
      budget: 1000,
      current_round: 50,
      last_exploit_round: 10,
      consecutive_clean: 40,
      working_spec: validFormalSpec,
      exploits: [],
      coverage: null,
      tier2_introduced: false,
      error_message: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    }])

    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/refine', '{}', creator)
    expect(res.status).toBe(409)

    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('REFINEMENT_IN_PROGRESS')
  })

  it('rejects unauthenticated request', async () => {
    mockDb.seedTable('policies', [makePolicyRow()])

    const res = await app.request('/v2/policies/policy-1/refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, env)
    expect(res.status).toBe(401)
  })

  it('returns 404 for missing policy', async () => {
    mockDb.seedTable('policies', [])

    const res = await makeSignedRequest('POST', '/v2/policies/nonexistent/refine', '{}', creator)
    expect(res.status).toBe(404)
  })
})

describe('GET /v2/policies/:id/refine/status', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('returns refinement status', async () => {
    mockDb.seedTable('refinements', [{
      id: 'ref-1',
      policy_id: 'policy-1',
      status: 'running',
      budget: 1000,
      current_round: 50,
      last_exploit_round: 10,
      consecutive_clean: 40,
      working_spec: validFormalSpec,
      exploits: [{ round: 5, exploit: {}, explanation: 'test' }, { round: 10, exploit: {}, explanation: 'test2' }],
      coverage: null,
      tier2_introduced: false,
      error_message: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    }])

    const res = await app.request('/v2/policies/policy-1/refine/status', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.status).toBe('running')
    expect(json.data.exploitsFound).toBe(2)
    expect(json.data.currentRound).toBe(50)
    expect(json.data.budget).toBe(1000)
  })

  it('returns completed refinement with coverage', async () => {
    mockDb.seedTable('refinements', [{
      id: 'ref-1',
      policy_id: 'policy-1',
      status: 'complete',
      budget: 1000,
      current_round: 1000,
      last_exploit_round: 50,
      consecutive_clean: 950,
      working_spec: validFormalSpec,
      exploits: [{ round: 50, exploit: {}, explanation: 'test' }],
      coverage: 0.95,
      tier2_introduced: false,
      error_message: null,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }])

    const res = await app.request('/v2/policies/policy-1/refine/status', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.status).toBe('complete')
    expect(json.data.coverageEstimate).toBe(0.95)
  })

  it('returns 404 when no refinement exists', async () => {
    mockDb.seedTable('refinements', [])

    const res = await app.request('/v2/policies/policy-1/refine/status', { method: 'GET' }, env)
    expect(res.status).toBe(404)
  })
})
