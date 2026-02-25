import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'

let mockDb: MockDb

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

// Mock the translation service to avoid real LLM calls in integration tests
const mockTranslatePolicy = vi.fn()
vi.mock('../lib/translation-service', () => ({
  translatePolicy: (...args: unknown[]) => mockTranslatePolicy(...args),
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'test-gateway-key',
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_mock',
}

const envWithOpenRouter = {
  ...env,
  OPENROUTER_API_KEY: 'or-test-key',
  TRANSLATOR_MODEL: 'test/translator',
  CROSS_VALIDATOR_MODEL: 'test/validator',
}

async function makeSignedRequest(
  method: string,
  path: string,
  body: string,
  keypair: { publicKey: string; privateKey: string },
  envOverride?: Record<string, unknown>,
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
  }, envOverride ?? env)
}

function seedAgent(keypair: { publicKey: string }) {
  mockDb.seedTable('agents', [
    {
      id: 'agent-1',
      public_key: keypair.publicKey,
      endpoint: null,
      name: 'creator',
      capabilities: [],
      metadata: {},
      parent_id: null,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    },
  ])
}

const validFormalSpec = {
  version: 1,
  constraints: [
    { id: 'c1', type: 'exists', target: '$.results', params: {} },
    { id: 'c2', type: 'count', target: '$.results', params: { min: 3 } },
    { id: 'c3', type: 'format', target: '$.results[*].url', params: { format: 'uri' } },
  ],
}

describe('POST /v2/policies', () => {
  let creator: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    creator = generateKeypair()
    seedAgent(creator)
    mockDb.seedTable('policies', [])
    mockDb.seedTable('policy_coverage', [])
  })

  it('creates policy with valid formal_spec → 201 validated', async () => {
    const body = JSON.stringify({
      name: 'web-search-v1',
      intent: 'Search must return at least 3 results with valid URLs',
      formalSpec: validFormalSpec,
    })

    const res = await makeSignedRequest('POST', '/v2/policies', body, creator)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: { name: string; status: string; formalSpec: unknown } }
    expect(json.data.name).toBe('web-search-v1')
    expect(json.data.status).toBe('validated')
    expect(json.data.formalSpec).toBeTruthy()
  })

  it('creates policy without formal_spec → 201 draft', async () => {
    const body = JSON.stringify({
      name: 'basic-policy',
      intent: 'Return something useful',
    })

    const res = await makeSignedRequest('POST', '/v2/policies', body, creator)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('draft')
  })

  it('rejects invalid formal_spec', async () => {
    const body = JSON.stringify({
      name: 'bad-policy',
      intent: 'test',
      formalSpec: { version: 2, constraints: [] },
    })

    const res = await makeSignedRequest('POST', '/v2/policies', body, creator)
    expect(res.status).toBe(400)
  })

  it('rejects missing name', async () => {
    const body = JSON.stringify({ intent: 'test' })
    const res = await makeSignedRequest('POST', '/v2/policies', body, creator)
    expect(res.status).toBe(400)
  })

  it('creates policy with clauses → coverage rows', async () => {
    const body = JSON.stringify({
      name: 'with-clauses',
      intent: 'test',
      formalSpec: {
        version: 1,
        constraints: [
          { id: 'c1', type: 'exists', target: '$.results', params: {}, clauseRef: '0' },
        ],
      },
      clauses: [
        { index: 0, text: 'Must return results' },
        { index: 1, text: 'Results must be recent' },
      ],
    })

    const res = await makeSignedRequest('POST', '/v2/policies', body, creator)
    expect(res.status).toBe(201)

    const coverage = mockDb.getTable('policy_coverage').rows
    expect(coverage).toHaveLength(2)
    expect(coverage[0].status).toBe('covered')
    expect(coverage[1].status).toBe('uncovered')
  })
})

describe('GET /v2/policies/:id', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('returns policy by ID', async () => {
    mockDb.seedTable('policies', [{
      id: 'policy-1',
      name: 'test-policy',
      description: null,
      intent: 'test',
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
    }])

    const res = await app.request('/v2/policies/policy-1', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { id: string; name: string } }
    expect(json.data.id).toBe('policy-1')
    expect(json.data.name).toBe('test-policy')
  })

  it('returns 404 for missing policy', async () => {
    mockDb.seedTable('policies', [])
    const res = await app.request('/v2/policies/nonexistent', { method: 'GET' }, env)
    expect(res.status).toBe(404)
  })
})

describe('POST /v2/policies/:id/activate', () => {
  let creator: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    creator = generateKeypair()
    seedAgent(creator)
  })

  it('activates validated policy', async () => {
    mockDb.seedTable('policies', [{
      id: 'policy-1',
      name: 'test',
      description: null,
      intent: 'test',
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
    }])

    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/activate', '{}', creator)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string; activatedAt: string } }
    expect(json.data.status).toBe('active')
    expect(json.data.activatedAt).toBeTruthy()
  })

  it('rejects activating draft policy', async () => {
    mockDb.seedTable('policies', [{
      id: 'policy-1',
      name: 'test',
      description: null,
      intent: 'test',
      formal_spec: { version: 1, constraints: [] },
      version: 1,
      status: 'draft',
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
    }])

    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/activate', '{}', creator)
    expect(res.status).toBe(409)
  })

  it('rejects non-creator', async () => {
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

    mockDb.seedTable('policies', [{
      id: 'policy-1',
      name: 'test',
      description: null,
      intent: 'test',
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
    }])

    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/activate', '{}', other)
    expect(res.status).toBe(403)
  })
})

describe('POST /v2/policies/:id/revise', () => {
  let creator: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    creator = generateKeypair()
    seedAgent(creator)
  })

  it('revises policy intent → resets to draft', async () => {
    mockDb.seedTable('policies', [{
      id: 'policy-1',
      name: 'test',
      description: null,
      intent: 'old intent',
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
    }])

    const body = JSON.stringify({ intent: 'new intent' })
    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/revise', body, creator)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { intent: string; status: string } }
    expect(json.data.intent).toBe('new intent')
    expect(json.data.status).toBe('draft')
  })

  it('revises with new formal_spec → validated', async () => {
    mockDb.seedTable('policies', [{
      id: 'policy-1',
      name: 'test',
      description: null,
      intent: 'test',
      formal_spec: { version: 1, constraints: [] },
      version: 1,
      status: 'draft',
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
    }])

    const body = JSON.stringify({ formalSpec: validFormalSpec })
    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/revise', body, creator)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('validated')
  })

  it('rejects revising active policy', async () => {
    mockDb.seedTable('policies', [{
      id: 'policy-1',
      name: 'test',
      description: null,
      intent: 'test',
      formal_spec: validFormalSpec,
      version: 1,
      status: 'active',
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
      activated_at: new Date().toISOString(),
      deprecated_at: null,
    }])

    const body = JSON.stringify({ intent: 'new' })
    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/revise', body, creator)
    expect(res.status).toBe(409)
  })
})

describe('GET /v2/policies/:id/coverage', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('returns coverage map', async () => {
    mockDb.seedTable('policy_coverage', [
      {
        id: 'cov-1',
        policy_id: 'policy-1',
        clause_index: 0,
        clause_text: 'Must return results',
        constraint_ids: ['c1'],
        status: 'covered',
        note: null,
      },
      {
        id: 'cov-2',
        policy_id: 'policy-1',
        clause_index: 1,
        clause_text: 'Results must be recent',
        constraint_ids: [],
        status: 'uncovered',
        note: null,
      },
    ])

    const res = await app.request('/v2/policies/policy-1/coverage', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { clauses: unknown[]; uncoveredCount: number } }
    expect(json.data.clauses).toHaveLength(2)
    expect(json.data.uncoveredCount).toBe(1)
  })

  it('returns empty coverage for unknown policy', async () => {
    mockDb.seedTable('policy_coverage', [])
    const res = await app.request('/v2/policies/unknown/coverage', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { clauses: unknown[]; uncoveredCount: number } }
    expect(json.data.clauses).toHaveLength(0)
  })
})

// ─── Phase 4: NL-to-Formal Translation Integration Tests ───

describe('POST /v2/policies — translation pipeline', () => {
  let creator: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    creator = generateKeypair()
    seedAgent(creator)
    mockDb.seedTable('policies', [])
    mockDb.seedTable('policy_coverage', [])
    mockTranslatePolicy.mockReset()
  })

  it('without formalSpec + with API key → calls translator, returns validated', async () => {
    mockTranslatePolicy.mockResolvedValue({
      status: 'validated',
      formalSpec: {
        version: 1,
        constraints: [{ id: 'c1', type: 'exists', target: '$.results', params: {} }],
      },
      clauses: [
        { index: 0, text: 'Return results', constraint_ids: ['c1'], status: 'covered' },
      ],
      translationModel: 'test/translator',
      crossValidatorModel: 'test/validator',
      crossValidation: { contradictions: [], uncovered_clauses: [], exploit: null, verdict: 'pass' },
      tier2Used: false,
    })

    const body = JSON.stringify({
      name: 'auto-translated',
      intent: 'Return search results',
    })

    const res = await makeSignedRequest('POST', '/v2/policies', body, creator, envWithOpenRouter)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.status).toBe('validated')
    expect(json.data.translationModel).toBe('test/translator')
    expect(json.data.crossValidator).toBe('test/validator')

    // translatePolicy was called
    expect(mockTranslatePolicy).toHaveBeenCalledTimes(1)
    const callArgs = mockTranslatePolicy.mock.calls[0][0]
    expect(callArgs.intent).toBe('Return search results')
  })

  it('without formalSpec + no API key → draft (graceful degradation)', async () => {
    const body = JSON.stringify({
      name: 'no-key',
      intent: 'Return results',
    })

    const res = await makeSignedRequest('POST', '/v2/policies', body, creator)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.status).toBe('draft')
    expect(json.data.translationModel).toBeNull()

    // translatePolicy was NOT called
    expect(mockTranslatePolicy).not.toHaveBeenCalled()
  })

  it('with formalSpec + API key → skips translation', async () => {
    const body = JSON.stringify({
      name: 'manual-spec',
      intent: 'test',
      formalSpec: validFormalSpec,
    })

    const res = await makeSignedRequest('POST', '/v2/policies', body, creator, envWithOpenRouter)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.status).toBe('validated')
    expect(mockTranslatePolicy).not.toHaveBeenCalled()
  })

  it('translator returns draft → policy status is draft', async () => {
    mockTranslatePolicy.mockResolvedValue({
      status: 'draft',
      formalSpec: { version: 1, constraints: [] },
      clauses: [],
      translationModel: 'test/translator',
      crossValidatorModel: null,
      crossValidation: null,
      tier2Used: false,
      errors: ['Attempt 1: garbage'],
    })

    const body = JSON.stringify({
      name: 'draft-result',
      intent: 'test',
    })

    const res = await makeSignedRequest('POST', '/v2/policies', body, creator, envWithOpenRouter)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.status).toBe('draft')
  })

  it('coverage rows auto-created from translation', async () => {
    mockTranslatePolicy.mockResolvedValue({
      status: 'validated',
      formalSpec: {
        version: 1,
        constraints: [{ id: 'c1', type: 'exists', target: '$.x', params: {} }],
      },
      clauses: [
        { index: 0, text: 'Has results', constraint_ids: ['c1'], status: 'covered' },
        { index: 1, text: 'Results recent', constraint_ids: [], status: 'uncovered' },
      ],
      translationModel: 'test/translator',
      crossValidatorModel: 'test/validator',
      crossValidation: { verdict: 'pass' },
      tier2Used: false,
    })

    const body = JSON.stringify({
      name: 'with-coverage',
      intent: 'test',
    })

    await makeSignedRequest('POST', '/v2/policies', body, creator, envWithOpenRouter)

    const coverage = mockDb.getTable('policy_coverage').rows
    expect(coverage).toHaveLength(2)
    expect(coverage[0].status).toBe('covered')
    expect(coverage[1].status).toBe('uncovered')
  })

  it('response includes crossValidation field', async () => {
    const cvResult = { contradictions: [], uncovered_clauses: [], exploit: null, verdict: 'pass' }
    mockTranslatePolicy.mockResolvedValue({
      status: 'validated',
      formalSpec: { version: 1, constraints: [{ id: 'c1', type: 'exists', target: '$.x', params: {} }] },
      clauses: [{ index: 0, text: 'test', constraint_ids: ['c1'], status: 'covered' }],
      translationModel: 'test/translator',
      crossValidatorModel: 'test/validator',
      crossValidation: cvResult,
      tier2Used: false,
    })

    const body = JSON.stringify({ name: 'cv-test', intent: 'test' })
    const res = await makeSignedRequest('POST', '/v2/policies', body, creator, envWithOpenRouter)
    const json = await res.json() as { data: Record<string, unknown> }

    // snakeToCamel converts stored JSON keys too
    expect(json.data.crossValidation).toEqual({
      contradictions: [],
      uncoveredClauses: [],
      exploit: null,
      verdict: 'pass',
    })
  })
})

describe('POST /v2/policies/:id/revise — translation pipeline', () => {
  let creator: ReturnType<typeof generateKeypair>

  beforeEach(() => {
    mockDb = createMockDb()
    creator = generateKeypair()
    seedAgent(creator)
    mockDb.seedTable('policy_coverage', [])
    mockTranslatePolicy.mockReset()
  })

  it('revise with only intent + API key → triggers translation', async () => {
    mockDb.seedTable('policies', [{
      id: 'policy-1',
      name: 'test',
      description: null,
      intent: 'old intent',
      formal_spec: { version: 1, constraints: [] },
      version: 1,
      status: 'draft',
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
    }])

    mockTranslatePolicy.mockResolvedValue({
      status: 'validated',
      formalSpec: {
        version: 1,
        constraints: [{ id: 'c1', type: 'exists', target: '$.x', params: {} }],
      },
      clauses: [{ index: 0, text: 'New clause', constraint_ids: ['c1'], status: 'covered' }],
      translationModel: 'test/translator',
      crossValidatorModel: 'test/validator',
      crossValidation: { verdict: 'pass' },
      tier2Used: false,
    })

    const body = JSON.stringify({ intent: 'new intent' })
    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/revise', body, creator, envWithOpenRouter)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.status).toBe('validated')
    expect(json.data.translationModel).toBe('test/translator')
    expect(mockTranslatePolicy).toHaveBeenCalledTimes(1)
  })

  it('revise with only intent + no API key → draft (no translation)', async () => {
    mockDb.seedTable('policies', [{
      id: 'policy-1',
      name: 'test',
      description: null,
      intent: 'old intent',
      formal_spec: { version: 1, constraints: [] },
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
    }])

    const body = JSON.stringify({ intent: 'new intent' })
    const res = await makeSignedRequest('POST', '/v2/policies/policy-1/revise', body, creator)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.status).toBe('draft')
    expect(mockTranslatePolicy).not.toHaveBeenCalled()
  })
})
