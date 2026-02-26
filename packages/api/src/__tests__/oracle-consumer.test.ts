/**
 * Tests for oracle dispatch queue consumer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockOracle } from './helpers/mock-oracle'
import { handleOracleDispatch, type OracleQueueMessage } from '../queue/oracle-consumer'
import type { OraclePoolRow } from '../lib/types'

let mockDb: MockDb
const mockOracle = createMockOracle()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'a'.repeat(64),
  SANDBOX_KEYS: 'test',
  STRIPE_SECRET_KEY: 'sk_test',
  ORACLE_FEE_CENTS: '100',
  ORACLE_VOTING_WINDOW_SECONDS: '1800',
  QUEUE: { send: vi.fn() },
}

function makeOracles(count: number): OraclePoolRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `pool-${i}`,
    agent_id: `oracle-agent-${i}`,
    status: 'active' as const,
    capabilities: [],
    tasks_completed: 0,
    accuracy_score: 1.0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  }))
}

describe('handleOracleDispatch', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    mockOracle.reset()
    mockDb.seedTable('escrows', [
      {
        id: 'esc-1',
        buyer_id: 'buyer-1',
        seller_id: 'seller-1',
        amount_cents: 1000,
        seller_collateral: 500,
        task_hash: 'abc',
        task_spec: { prompt: 'test' },
        policy_id: 'pol-1',
        verification_method: 'oracle_consensus',
        dispute_resolution: 'burn',
        status: 'delivered',
        proof: 'proof-hash',
        created_at: '2025-01-01T00:00:00Z',
        funded_at: '2025-01-01T00:00:00Z',
        completed_at: null,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        delivery_attempts: 1,
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

  it('selects oracles and creates task', async () => {
    mockOracle.setOracles(makeOracles(5))

    const msg: OracleQueueMessage = {
      type: 'oracle_dispatch',
      escrowId: 'esc-1',
      deliverable: { text: 'result' },
    }

    await handleOracleDispatch(msg, env as never, mockOracle)

    expect(mockOracle.calls).toHaveLength(2) // selectOracles + createTask
    expect(mockOracle.calls[0].method).toBe('selectOracles')
    expect(mockOracle.calls[0].params).toEqual({
      buyerId: 'buyer-1',
      sellerId: 'seller-1',
      count: 5,
    })
    expect(mockOracle.calls[1].method).toBe('createTask')
    expect(mockOracle.calls[1].params.escrowId).toBe('esc-1')
    expect(mockOracle.calls[1].params.quorum).toBe(3)
  })

  it('falls back to buyer_confirm when insufficient oracles', async () => {
    mockOracle.setOracles(makeOracles(3)) // Only 3, need 5

    const msg: OracleQueueMessage = {
      type: 'oracle_dispatch',
      escrowId: 'esc-1',
      deliverable: { text: 'result' },
    }

    await handleOracleDispatch(msg, env as never, mockOracle)

    // Should have called selectOracles but not createTask
    expect(mockOracle.calls).toHaveLength(1)
    expect(mockOracle.calls[0].method).toBe('selectOracles')

    // Escrow should be updated to buyer_confirm
    const escrow = mockDb.getTable('escrows').rows[0]
    expect(escrow.verification_method).toBe('buyer_confirm')
  })

  it('skips if escrow not in delivered state', async () => {
    mockDb.seedTable('escrows', [
      {
        id: 'esc-1',
        buyer_id: 'buyer-1',
        seller_id: 'seller-1',
        status: 'released', // Already resolved
        task_spec: {},
        policy_id: null,
        amount_cents: 1000,
        seller_collateral: 500,
        task_hash: 'abc',
        verification_method: 'oracle_consensus',
        dispute_resolution: 'burn',
        proof: null,
        created_at: '2025-01-01T00:00:00Z',
        funded_at: null,
        completed_at: '2025-01-01T00:01:00Z',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        delivery_attempts: 1,
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

    mockOracle.setOracles(makeOracles(5))

    const msg: OracleQueueMessage = {
      type: 'oracle_dispatch',
      escrowId: 'esc-1',
      deliverable: { text: 'result' },
    }

    await handleOracleDispatch(msg, env as never, mockOracle)

    // No oracle calls made
    expect(mockOracle.calls).toHaveLength(0)
  })

  it('skips if escrow not found', async () => {
    mockOracle.setOracles(makeOracles(5))

    const msg: OracleQueueMessage = {
      type: 'oracle_dispatch',
      escrowId: 'nonexistent',
      deliverable: { text: 'result' },
    }

    await handleOracleDispatch(msg, env as never, mockOracle)

    expect(mockOracle.calls).toHaveLength(0)
  })
})
