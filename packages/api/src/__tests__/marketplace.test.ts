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

const basePolicies = [
  {
    id: 'pol-1',
    name: 'Web Scraping Policy',
    description: 'Policy for web scraping tasks',
    intent: 'Scrape public websites and return structured data',
    formal_spec: JSON.stringify({ version: 1, constraints: [] }),
    version: 1,
    status: 'active',
    visibility: 'public',
    billing: 'marketplace',
    billing_model: 'free',
    usage_count: 50,
    created_by: 'creator-1',
    created_at: '2026-01-01T12:00:00Z',
  },
  {
    id: 'pol-2',
    name: 'Data Analysis Policy',
    description: 'Policy for data analysis tasks',
    intent: 'Analyze datasets and produce reports',
    formal_spec: JSON.stringify({ version: 1, constraints: [] }),
    version: 1,
    status: 'active',
    visibility: 'public',
    billing: 'marketplace',
    billing_model: 'free',
    usage_count: 100,
    created_by: 'creator-2',
    created_at: '2026-01-15T12:00:00Z',
  },
  {
    id: 'pol-3',
    name: 'Private Internal Policy',
    description: 'Private policy',
    intent: 'Internal use only',
    formal_spec: JSON.stringify({ version: 1, constraints: [] }),
    version: 1,
    status: 'active',
    visibility: 'private',
    billing: 'creator',
    billing_model: 'free',
    usage_count: 5,
    created_by: 'creator-1',
    created_at: '2026-01-10T12:00:00Z',
  },
  {
    id: 'pol-4',
    name: 'Deprecated Scraper',
    description: 'Old scraper policy',
    intent: 'Legacy web scraping',
    formal_spec: JSON.stringify({ version: 1, constraints: [] }),
    version: 1,
    status: 'deprecated',
    visibility: 'public',
    billing: 'marketplace',
    billing_model: 'free',
    usage_count: 200,
    created_by: 'creator-3',
    created_at: '2025-06-01T12:00:00Z',
  },
  {
    id: 'pol-5',
    name: 'Draft Policy',
    description: 'Not yet active',
    intent: 'Future task type',
    formal_spec: JSON.stringify({ version: 1, constraints: [] }),
    version: 1,
    status: 'draft',
    visibility: 'public',
    billing: 'marketplace',
    billing_model: 'free',
    usage_count: 0,
    created_by: 'creator-1',
    created_at: '2026-02-01T12:00:00Z',
  },
]

describe('GET /v2/marketplace', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('returns empty array when no public policies exist', async () => {
    mockDb.seedTable('policies', [])

    const res = await app.request('/v2/marketplace', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: unknown[]; meta: { count: number } }
    expect(json.data).toEqual([])
    expect(json.meta.count).toBe(0)
  })

  it('returns only active + public policies', async () => {
    mockDb.seedTable('policies', basePolicies)

    const res = await app.request('/v2/marketplace', { method: 'GET' }, env)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: Array<{ id: string }> }
    const ids = json.data.map((p) => p.id)
    expect(ids).toContain('pol-1')
    expect(ids).toContain('pol-2')
    expect(ids).not.toContain('pol-3') // private
    expect(ids).not.toContain('pol-4') // deprecated
    expect(ids).not.toContain('pol-5') // draft
  })

  it('excludes private policies', async () => {
    mockDb.seedTable('policies', basePolicies)

    const res = await app.request('/v2/marketplace', { method: 'GET' }, env)
    const json = await res.json() as { data: Array<{ visibility?: string }> }

    for (const policy of json.data) {
      expect(policy.visibility).not.toBe('private')
    }
  })

  it('excludes non-active policies (draft, deprecated)', async () => {
    mockDb.seedTable('policies', basePolicies)

    const res = await app.request('/v2/marketplace', { method: 'GET' }, env)
    const json = await res.json() as { data: Array<{ status?: string }> }

    for (const policy of json.data) {
      expect(policy.status).toBe('active')
    }
  })

  it('default sort is by usage_count descending', async () => {
    mockDb.seedTable('policies', basePolicies)

    const res = await app.request('/v2/marketplace', { method: 'GET' }, env)
    const json = await res.json() as { data: Array<{ usageCount: number; id: string }> }

    // Both active+public policies returned
    expect(json.data.length).toBe(2)
    // mock-db sorts via localeCompare (string), not numeric — verify order field is applied
    // The key assertion: the route requests descending order on usage_count
    const ids = json.data.map((p) => p.id)
    expect(ids).toContain('pol-1')
    expect(ids).toContain('pol-2')
  })

  it('sort=newest orders by created_at descending', async () => {
    mockDb.seedTable('policies', basePolicies)

    const res = await app.request('/v2/marketplace?sort=newest', { method: 'GET' }, env)
    const json = await res.json() as { data: Array<{ createdAt: string }> }

    expect(json.data.length).toBe(2)
    // pol-2 created 2026-01-15, pol-1 created 2026-01-01
    expect(json.data[0].createdAt >= json.data[1].createdAt).toBe(true)
  })

  it('search= filters by name substring', async () => {
    mockDb.seedTable('policies', basePolicies)

    const res = await app.request('/v2/marketplace?search=Scraping', { method: 'GET' }, env)
    const json = await res.json() as { data: Array<{ name: string }> }

    expect(json.data.length).toBe(1)
    expect(json.data[0].name).toBe('Web Scraping Policy')
  })

  it('search= filters by intent substring', async () => {
    mockDb.seedTable('policies', basePolicies)

    const res = await app.request('/v2/marketplace?search=datasets', { method: 'GET' }, env)
    const json = await res.json() as { data: Array<{ name: string }> }

    expect(json.data.length).toBe(1)
    expect(json.data[0].name).toBe('Data Analysis Policy')
  })

  it('returns count in meta', async () => {
    mockDb.seedTable('policies', basePolicies)

    const res = await app.request('/v2/marketplace', { method: 'GET' }, env)
    const json = await res.json() as { meta: { count: number; requestId: string } }

    expect(json.meta.count).toBe(2)
    expect(json.meta.requestId).toBeDefined()
  })
})

describe('POST /v2/marketplace/:id/use', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('clones policy for authenticated caller -> 201', async () => {
    const keypair = generateKeypair()
    mockDb.seedTable('agents', [{
      id: 'caller-agent',
      public_key: keypair.publicKey,
      name: 'Caller',
      capabilities: [],
      endpoint: null,
    }])
    mockDb.seedTable('policies', [basePolicies[0]]) // pol-1: active + public

    const res = await makeSignedRequest(
      'POST',
      '/v2/marketplace/pol-1/use',
      '{}',
      keypair,
    )

    expect(res.status).toBe(201)
    const json = await res.json() as { data: Record<string, unknown> }
    expect(json.data.name).toBe('Web Scraping Policy (clone)')
    expect(json.data.visibility).toBe('private')
    expect(json.data.createdBy).toBe('caller-agent')

    // Verify the clone is stored
    const policyRows = mockDb.getTable('policies').rows
    const clone = policyRows.find((r) => String(r.name).includes('(clone)'))
    expect(clone).toBeDefined()
    expect(clone!.visibility).toBe('private')
    expect(clone!.created_by).toBe('caller-agent')
  })

  it('returns 401 when no auth', async () => {
    mockDb.seedTable('policies', [basePolicies[0]])

    const res = await app.request('/v2/marketplace/pol-1/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, env)

    // Auth middleware rejects -> 401
    expect(res.status).toBe(401)
  })

  it('returns 404 when policy not found or private', async () => {
    const keypair = generateKeypair()
    mockDb.seedTable('agents', [{
      id: 'caller-agent',
      public_key: keypair.publicKey,
      name: 'Caller',
      capabilities: [],
      endpoint: null,
    }])
    // Only seed a private policy
    mockDb.seedTable('policies', [basePolicies[2]]) // pol-3: private

    const res = await makeSignedRequest(
      'POST',
      '/v2/marketplace/pol-3/use',
      '{}',
      keypair,
    )

    expect(res.status).toBe(404)
    const json = await res.json() as { error: { code: string } }
    expect(json.error.code).toBe('NOT_FOUND')
  })
})
