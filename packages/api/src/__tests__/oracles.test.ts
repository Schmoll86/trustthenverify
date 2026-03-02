/**
 * Integration tests for oracle pool + voting routes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
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
  ORACLE_FEE_CENTS: '100',
  ORACLE_VOTING_WINDOW_SECONDS: '1800',
  QUEUE: { send: vi.fn() },
}

const oracleKp = generateKeypair()
const oracle2Kp = generateKeypair()
const buyerKp = generateKeypair()
const sellerKp = generateKeypair()

function seedAgents() {
  mockDb.seedTable('agents', [
    {
      id: 'oracle-agent-id',
      public_key: oracleKp.publicKey,
      endpoint: null,
      name: 'oracle1',
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
      id: 'oracle2-agent-id',
      public_key: oracle2Kp.publicKey,
      endpoint: null,
      name: 'oracle2',
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
      id: 'buyer-agent-id',
      public_key: buyerKp.publicKey,
      endpoint: null,
      name: 'buyer',
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
      id: 'seller-agent-id',
      public_key: sellerKp.publicKey,
      endpoint: null,
      name: 'seller',
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
  }, env as unknown as Record<string, unknown>)
}

async function makeSandboxRequest(method: string, path: string, body?: string) {
  return app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Sandbox-Key': 'test_sandbox_key_123',
    },
    body: method === 'GET' ? undefined : body,
  }, env as unknown as Record<string, unknown>)
}

// ── Join pool ──

describe('POST /v2/oracles/join', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    seedAgents()
  })

  it('joins oracle pool -> 201', async () => {
    const body = JSON.stringify({ capabilities: ['code_review'] })
    const res = await makeSignedRequest('POST', '/v2/oracles/join', body, oracleKp)
    expect(res.status).toBe(201)
    const json = await res.json() as { data: { agentId: string; status: string; capabilities: string[] } }
    expect(json.data.agentId).toBe('oracle-agent-id')
    expect(json.data.status).toBe('active')
    expect(json.data.capabilities).toEqual(['code_review'])
  })

  it('re-activates withdrawn oracle -> 200', async () => {
    mockDb.seedTable('oracle_pool', [
      {
        id: 'pool-1',
        agent_id: 'oracle-agent-id',
        status: 'withdrawn',
        capabilities: [],
        tasks_completed: 5,
        accuracy_score: 0.9,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    ])

    const body = JSON.stringify({ capabilities: ['new_cap'] })
    const res = await makeSignedRequest('POST', '/v2/oracles/join', body, oracleKp)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('active')
  })

  it('rejects duplicate join -> 409', async () => {
    mockDb.seedTable('oracle_pool', [
      {
        id: 'pool-1',
        agent_id: 'oracle-agent-id',
        status: 'active',
        capabilities: [],
        tasks_completed: 0,
        accuracy_score: 1.0,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    ])

    const body = JSON.stringify({})
    const res = await makeSignedRequest('POST', '/v2/oracles/join', body, oracleKp)
    expect(res.status).toBe(409)
  })
})

// ── Withdraw ──

describe('POST /v2/oracles/withdraw', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    seedAgents()
    mockDb.seedTable('oracle_pool', [
      {
        id: 'pool-1',
        agent_id: 'oracle-agent-id',
        status: 'active',
        capabilities: [],
        tasks_completed: 0,
        accuracy_score: 1.0,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    ])
  })

  it('withdraws from pool -> 200', async () => {
    const res = await makeSignedRequest('POST', '/v2/oracles/withdraw', '{}', oracleKp)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('withdrawn')
  })

  it('rejects if not in pool -> 404', async () => {
    const res = await makeSignedRequest('POST', '/v2/oracles/withdraw', '{}', oracle2Kp)
    expect(res.status).toBe(404)
  })

  it('rejects double withdraw -> 409', async () => {
    // First withdraw
    await makeSignedRequest('POST', '/v2/oracles/withdraw', '{}', oracleKp)
    // Second withdraw
    const res = await makeSignedRequest('POST', '/v2/oracles/withdraw', '{}', oracleKp)
    expect(res.status).toBe(409)
  })
})

// ── Status ──

describe('GET /v2/oracles/status', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    seedAgents()
    mockDb.seedTable('oracle_pool', [
      {
        id: 'pool-1',
        agent_id: 'oracle-agent-id',
        status: 'active',
        capabilities: ['code_review'],
        tasks_completed: 10,
        accuracy_score: 0.85,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    ])
  })

  it('returns pool stats -> 200', async () => {
    const res = await makeSignedRequest('GET', '/v2/oracles/status', '', oracleKp)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { tasksCompleted: number; accuracyScore: number } }
    expect(json.data.tasksCompleted).toBe(10)
    expect(json.data.accuracyScore).toBe(0.85)
  })

  it('returns 404 if not in pool', async () => {
    const res = await makeSignedRequest('GET', '/v2/oracles/status', '', oracle2Kp)
    expect(res.status).toBe(404)
  })
})

// ── Tasks (assignments) ──

describe('GET /v2/oracles/tasks', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    seedAgents()
  })

  it('returns empty when no assignments -> 200', async () => {
    const res = await makeSignedRequest('GET', '/v2/oracles/tasks', '', oracleKp)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: unknown[] }
    expect(json.data).toEqual([])
  })

  it('returns pending vote assignments', async () => {
    const taskId = 'task-1'
    mockDb.seedTable('oracle_tasks', [
      {
        id: taskId,
        escrow_id: 'esc-1',
        status: 'voting',
        quorum: 3,
        total_oracles: 5,
        consensus: null,
        deliverable: { text: 'hello' },
        task_spec: null,
        policy_id: null,
        votes_pass: 0,
        votes_fail: 0,
        expires_at: new Date(Date.now() + 1800000).toISOString(),
        decided_at: null,
        created_at: new Date().toISOString(),
      },
    ])
    mockDb.seedTable('oracle_votes', [
      {
        id: 'vote-1',
        oracle_task_id: taskId,
        oracle_id: 'pool-1',
        agent_id: 'oracle-agent-id',
        status: 'pending',
        verdict: null,
        rationale: null,
        submitted_at: null,
        created_at: new Date().toISOString(),
      },
    ])

    const res = await makeSignedRequest('GET', '/v2/oracles/tasks', '', oracleKp)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: Array<{ oracleTaskId: string }> }
    expect(json.data).toHaveLength(1)
    expect(json.data[0].oracleTaskId).toBe(taskId)
  })
})

// ── Vote ──

describe('POST /v2/oracles/vote', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    seedAgents()
    mockDb.seedTable('oracle_pool', [
      {
        id: 'pool-1',
        agent_id: 'oracle-agent-id',
        status: 'active',
        capabilities: [],
        tasks_completed: 0,
        accuracy_score: 1.0,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    ])
    mockDb.seedTable('escrows', [
      {
        id: 'esc-1',
        buyer_id: 'buyer-agent-id',
        seller_id: 'seller-agent-id',
        amount_cents: 1000,
        seller_collateral: 500,
        task_hash: 'abc',
        task_spec: {},
        policy_id: null,
        verification_method: 'oracle_consensus',
        dispute_resolution: 'burn',
        status: 'delivered',
        proof: null,
        created_at: '2025-01-01T00:00:00Z',
        funded_at: null,
        completed_at: null,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        delivery_attempts: 1,
        timeout_seconds: 3600,
        funding_mode: 'stripe',
        buyer_address: null,
        seller_address: null,
        buyer_funded: false,
        seller_funded: false,
        chain_id: null,
        tx_hash: null,
      },
    ])
    mockDb.seedTable('oracle_tasks', [
      {
        id: 'task-1',
        escrow_id: 'esc-1',
        status: 'voting',
        quorum: 3,
        total_oracles: 5,
        consensus: null,
        deliverable: { text: 'hello' },
        task_spec: null,
        policy_id: null,
        votes_pass: 0,
        votes_fail: 0,
        expires_at: new Date(Date.now() + 1800000).toISOString(),
        decided_at: null,
        created_at: new Date().toISOString(),
      },
    ])
    mockDb.seedTable('oracle_votes', [
      {
        id: 'vote-1',
        oracle_task_id: 'task-1',
        oracle_id: 'pool-1',
        agent_id: 'oracle-agent-id',
        status: 'pending',
        verdict: null,
        rationale: null,
        submitted_at: null,
        created_at: new Date().toISOString(),
      },
    ])
  })

  it('submits pass vote -> 200', async () => {
    const body = JSON.stringify({
      oracleTaskId: 'task-1',
      verdict: 'pass',
      rationale: 'Looks good',
    })
    const res = await makeSignedRequest('POST', '/v2/oracles/vote', body, oracleKp)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { voted: boolean; verdict: string } }
    expect(json.data.voted).toBe(true)
    expect(json.data.verdict).toBe('pass')
  })

  it('rejects invalid verdict -> 400', async () => {
    const body = JSON.stringify({
      oracleTaskId: 'task-1',
      verdict: 'maybe',
    })
    const res = await makeSignedRequest('POST', '/v2/oracles/vote', body, oracleKp)
    expect(res.status).toBe(400)
  })

  it('rejects missing oracleTaskId -> 400', async () => {
    const body = JSON.stringify({ verdict: 'pass' })
    const res = await makeSignedRequest('POST', '/v2/oracles/vote', body, oracleKp)
    expect(res.status).toBe(400)
  })

  it('rejects vote from non-pool agent -> 403', async () => {
    const body = JSON.stringify({
      oracleTaskId: 'task-1',
      verdict: 'pass',
    })
    const res = await makeSignedRequest('POST', '/v2/oracles/vote', body, oracle2Kp)
    expect(res.status).toBe(403)
  })

  it('rejects double vote -> 409', async () => {
    const body = JSON.stringify({
      oracleTaskId: 'task-1',
      verdict: 'pass',
    })
    // First vote
    await makeSignedRequest('POST', '/v2/oracles/vote', body, oracleKp)
    // Second vote
    const res = await makeSignedRequest('POST', '/v2/oracles/vote', body, oracleKp)
    expect(res.status).toBe(409)
  })
})

// ── Public task status ──

describe('GET /v2/oracles/task/:id', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    seedAgents()
    mockDb.seedTable('oracle_tasks', [
      {
        id: 'task-1',
        escrow_id: 'esc-1',
        status: 'voting',
        quorum: 3,
        total_oracles: 5,
        consensus: null,
        deliverable: { text: 'hello' },
        task_spec: null,
        policy_id: null,
        votes_pass: 1,
        votes_fail: 0,
        expires_at: new Date(Date.now() + 1800000).toISOString(),
        decided_at: null,
        created_at: new Date().toISOString(),
      },
    ])
    mockDb.seedTable('oracle_votes', [
      {
        id: 'vote-1',
        oracle_task_id: 'task-1',
        oracle_id: 'pool-1',
        agent_id: 'oracle-agent-id',
        status: 'submitted',
        verdict: 'pass',
        rationale: 'LGTM',
        submitted_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    ])
  })

  it('returns task with votes -> 200 (no auth required)', async () => {
    const res = await makeSandboxRequest('GET', '/v2/oracles/task/task-1')
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { status: string; votes: Array<{ verdict: string }> } }
    expect(json.data.status).toBe('voting')
    expect(json.data.votes).toHaveLength(1)
    expect(json.data.votes[0].verdict).toBe('pass')
  })

  it('returns 404 for missing task', async () => {
    const res = await makeSandboxRequest('GET', '/v2/oracles/task/nonexistent')
    expect(res.status).toBe(404)
  })
})

// ── Deliver with oracle_consensus ──

describe('POST /v2/escrow/:id/deliver (oracle_consensus)', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    ;(env.QUEUE.send as ReturnType<typeof vi.fn>).mockReset()
    seedAgents()
    mockDb.seedTable('escrows', [
      {
        id: 'esc-1',
        buyer_id: 'buyer-agent-id',
        seller_id: 'seller-agent-id',
        amount_cents: 1000,
        seller_collateral: 500,
        task_hash: 'abc',
        task_spec: { prompt: 'test' },
        policy_id: null,
        verification_method: 'oracle_consensus',
        dispute_resolution: 'burn',
        status: 'active',
        proof: null,
        created_at: '2025-01-01T00:00:00Z',
        funded_at: '2025-01-01T00:00:00Z',
        completed_at: null,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        delivery_attempts: 0,
        timeout_seconds: 3600,
        funding_mode: 'stripe',
        stripe_escrow_id: 'pi_test',
        buyer_address: null,
        seller_address: null,
        buyer_funded: false,
        seller_funded: false,
        chain_id: null,
        tx_hash: null,
      },
    ])
  })

  it('enqueues oracle_dispatch and returns delivered', async () => {
    const body = JSON.stringify({ deliverable: { text: 'result' } })
    const res = await makeSignedRequest('POST', '/v2/escrow/esc-1/deliver', body, sellerKp)
    expect(res.status).toBe(200)
    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('delivered')

    // Verify queue message was sent
    expect(env.QUEUE.send).toHaveBeenCalledWith({
      type: 'oracle_dispatch',
      escrowId: 'esc-1',
      deliverable: { text: 'result' },
    })
  })
})
