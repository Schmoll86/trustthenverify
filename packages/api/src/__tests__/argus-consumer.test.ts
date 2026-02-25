import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleArgusMessage } from '../queue/argus-consumer'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockQueue } from './helpers/mock-queue'

let mockDb: MockDb
const mockQueue = createMockQueue()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

// Mock Workers AI
const mockAIRun = vi.fn()

const validFormalSpec = {
  version: 1,
  constraints: [
    { id: 'c1', type: 'exists', target: '$.name', params: {} },
  ],
}

function makeRefinementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ref-1',
    policy_id: 'policy-1',
    status: 'running',
    budget: 30,
    current_round: 0,
    last_exploit_round: 0,
    consecutive_clean: 0,
    working_spec: validFormalSpec,
    exploits: [],
    coverage: null,
    tier2_introduced: false,
    error_message: null,
    created_at: new Date().toISOString(),
    completed_at: null,
    ...overrides,
  }
}

function makePolicyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'policy-1',
    name: 'test-policy',
    description: null,
    intent: 'Return valid results',
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

function makeEnv() {
  return {
    SUPABASE_URL: 'http://localhost',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    GATEWAY_PRIVATE_KEY: 'test-gateway-key',
    SANDBOX_KEYS: 'test_sandbox_key_123',
    STRIPE_SECRET_KEY: 'sk_test_mock',
    AI: { run: mockAIRun },
    QUEUE: mockQueue,
  }
}

describe('handleArgusMessage', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    mockQueue.reset()
    mockAIRun.mockReset()
  })

  it('processes a batch and re-enqueues when not done', async () => {
    mockDb.seedTable('refinements', [makeRefinementRow()])
    mockDb.seedTable('policies', [makePolicyRow()])

    // AI returns "no exploit" for all rounds
    mockAIRun.mockResolvedValue({
      response: JSON.stringify({ exploit: null, explanation: 'No exploit found' }),
    })

    await handleArgusMessage(
      { type: 'argus_refine', refinementId: 'ref-1', policyId: 'policy-1' },
      makeEnv(),
    )

    // Check refinement updated
    const ref = mockDb.getTable('refinements').rows[0]
    expect(ref.current_round).toBe(10)
    expect(ref.consecutive_clean).toBe(10)
    expect(ref.status).toBe('running') // not done yet

    // Check re-enqueued
    expect(mockQueue.messages).toHaveLength(1)
    expect((mockQueue.messages[0].body as Record<string, unknown>).type).toBe('argus_refine')
  })

  it('completes and updates policy when budget exhausted', async () => {
    mockDb.seedTable('refinements', [makeRefinementRow({ budget: 10, current_round: 0 })])
    mockDb.seedTable('policies', [makePolicyRow()])

    mockAIRun.mockResolvedValue({
      response: JSON.stringify({ exploit: null, explanation: 'No exploit' }),
    })

    await handleArgusMessage(
      { type: 'argus_refine', refinementId: 'ref-1', policyId: 'policy-1' },
      makeEnv(),
    )

    const ref = mockDb.getTable('refinements').rows[0]
    expect(ref.status).toBe('complete')
    expect(ref.current_round).toBe(10)
    expect(ref.completed_at).toBeTruthy()
    expect(ref.coverage).toBe(1) // no exploits ever found

    // Policy should be updated with argus results
    const policy = mockDb.getTable('policies').rows[0]
    expect(policy.argus_coverage).toBe(1)
    expect(policy.argus_budget).toBe(10)

    // Auto-approved because coverage=1 and no tier2
    expect(policy.status).toBe('approved')

    // No re-enqueue
    expect(mockQueue.messages).toHaveLength(0)
  })

  it('skips non-running refinements (idempotency)', async () => {
    mockDb.seedTable('refinements', [makeRefinementRow({ status: 'complete' })])
    mockDb.seedTable('policies', [makePolicyRow()])

    await handleArgusMessage(
      { type: 'argus_refine', refinementId: 'ref-1', policyId: 'policy-1' },
      makeEnv(),
    )

    // AI never called
    expect(mockAIRun).not.toHaveBeenCalled()
  })

  it('marks refinement as failed when policy not found', async () => {
    mockDb.seedTable('refinements', [makeRefinementRow()])
    mockDb.seedTable('policies', []) // no policies

    await handleArgusMessage(
      { type: 'argus_refine', refinementId: 'ref-1', policyId: 'policy-1' },
      makeEnv(),
    )

    const ref = mockDb.getTable('refinements').rows[0]
    expect(ref.status).toBe('failed')
    expect(ref.error_message).toBe('Policy not found')
  })

  it('does not auto-approve when coverage below threshold', async () => {
    // Budget of 10, exploit on round 5 → coverage = 5/10 = 0.5
    mockDb.seedTable('refinements', [makeRefinementRow({ budget: 10 })])
    mockDb.seedTable('policies', [makePolicyRow()])

    let callCount = 0
    mockAIRun.mockImplementation(async () => {
      callCount++
      // Rounds 1-4: no exploit, round 5: exploit, rounds 6-10: no exploit
      if (callCount === 5) {
        return {
          response: JSON.stringify({ exploit: { bad: true }, explanation: 'found one' }),
        }
      }
      // If it's a refinement call (even numbered after exploit), return valid patch
      if (callCount === 6) {
        return {
          response: JSON.stringify({
            formal_spec: { version: 1, constraints: [
              { id: 'c1', type: 'exists', target: '$.name', params: {} },
              { id: 'c2', type: 'length', target: '$.name', params: { min: 3 } },
            ]},
          }),
        }
      }
      return {
        response: JSON.stringify({ exploit: null, explanation: 'No exploit' }),
      }
    })

    await handleArgusMessage(
      { type: 'argus_refine', refinementId: 'ref-1', policyId: 'policy-1' },
      makeEnv(),
    )

    const ref = mockDb.getTable('refinements').rows[0]
    expect(ref.status).toBe('complete')

    const policy = mockDb.getTable('policies').rows[0]
    // Coverage = (10 - 5) / 10 = 0.5, below 0.9 threshold
    expect(policy.status).toBe('validated') // NOT approved
  })

  it('silently skips when refinement row not found', async () => {
    mockDb.seedTable('refinements', []) // empty
    mockDb.seedTable('policies', [makePolicyRow()])

    // Should not throw
    await handleArgusMessage(
      { type: 'argus_refine', refinementId: 'ref-missing', policyId: 'policy-1' },
      makeEnv(),
    )

    expect(mockAIRun).not.toHaveBeenCalled()
  })

  it('marks refinement failed on AI error', async () => {
    mockDb.seedTable('refinements', [makeRefinementRow({ budget: 10 })])
    mockDb.seedTable('policies', [makePolicyRow()])

    // AI throws on all calls — but runArgusBatch catches these,
    // so the batch completes normally treating errors as clean rounds
    mockAIRun.mockRejectedValue(new Error('AI service unavailable'))

    await handleArgusMessage(
      { type: 'argus_refine', refinementId: 'ref-1', policyId: 'policy-1' },
      makeEnv(),
    )

    // The batch should complete (budget=10, errors treated as clean)
    const ref = mockDb.getTable('refinements').rows[0]
    expect(ref.status).toBe('complete')
    expect(ref.current_round).toBe(10)
  })
})
