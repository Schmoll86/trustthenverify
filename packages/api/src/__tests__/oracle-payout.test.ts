import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleOraclePayouts } from '../cron/escrow-timeout'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockStripe } from './helpers/mock-stripe'

let mockDb: MockDb

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'test-gateway-key',
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_123',
}

describe('handleOraclePayouts', () => {
  beforeEach(() => {
    mockDb = createMockDb()
  })

  it('pays oracle with completed Connect onboarding', async () => {
    mockDb.seedTable('oracle_payments', [{
      id: 'op-1',
      oracle_task_id: 'ot-1',
      oracle_id: 'oracle-1',
      agent_id: 'agent-1',
      amount_cents: 250,
      status: 'pending',
      funded_by: 'buyer_surcharge',
      created_at: '2026-02-01T00:00:00Z',
    }])

    mockDb.seedTable('agents', [{
      id: 'agent-1',
      public_key: 'pk_oracle',
      stripe_connected_account_id: 'acct_oracle_1',
      stripe_onboarding_complete: true,
      name: 'Oracle Agent',
    }])

    const stripe = createMockStripe()
    const result = await handleOraclePayouts(env as never, stripe)

    expect(result.paid).toBe(1)
    expect(result.skipped).toBe(0)

    // Verify transfer was called
    expect(stripe.calls).toHaveLength(1)
    expect(stripe.calls[0].method).toBe('transferToConnectedAccount')
    expect(stripe.calls[0].params).toMatchObject({
      amountCents: 250,
      connectedAccountId: 'acct_oracle_1',
    })

    // Verify payment status updated
    const payment = mockDb.getTable('oracle_payments').rows[0]
    expect(payment.status).toBe('paid')
  })

  it('skips oracle without Connect account', async () => {
    mockDb.seedTable('oracle_payments', [{
      id: 'op-2',
      oracle_task_id: 'ot-2',
      oracle_id: 'oracle-2',
      agent_id: 'agent-2',
      amount_cents: 500,
      status: 'pending',
      funded_by: 'buyer_surcharge',
      created_at: '2026-02-01T00:00:00Z',
    }])

    mockDb.seedTable('agents', [{
      id: 'agent-2',
      public_key: 'pk_oracle_2',
      stripe_connected_account_id: null,
      stripe_onboarding_complete: false,
      name: 'Oracle No Connect',
    }])

    const stripe = createMockStripe()
    const result = await handleOraclePayouts(env as never, stripe)

    expect(result.paid).toBe(0)
    expect(result.skipped).toBe(1)
    expect(stripe.calls).toHaveLength(0)

    // Payment stays pending
    const payment = mockDb.getTable('oracle_payments').rows[0]
    expect(payment.status).toBe('pending')
  })

  it('skips on Stripe transfer failure', async () => {
    mockDb.seedTable('oracle_payments', [{
      id: 'op-3',
      oracle_task_id: 'ot-3',
      oracle_id: 'oracle-3',
      agent_id: 'agent-3',
      amount_cents: 100,
      status: 'pending',
      funded_by: 'platform',
      created_at: '2026-02-01T00:00:00Z',
    }])

    mockDb.seedTable('agents', [{
      id: 'agent-3',
      public_key: 'pk_oracle_3',
      stripe_connected_account_id: 'acct_oracle_3',
      stripe_onboarding_complete: true,
      name: 'Oracle Fail',
    }])

    const stripe = createMockStripe()
    // Override to throw
    stripe.transferToConnectedAccount = async () => {
      throw new Error('Stripe transfer failed')
    }

    const result = await handleOraclePayouts(env as never, stripe)

    expect(result.paid).toBe(0)
    expect(result.skipped).toBe(1)

    // Payment stays pending for retry
    const payment = mockDb.getTable('oracle_payments').rows[0]
    expect(payment.status).toBe('pending')
  })

  it('returns zeros when no pending payments', async () => {
    mockDb.seedTable('oracle_payments', [])

    const stripe = createMockStripe()
    const result = await handleOraclePayouts(env as never, stripe)

    expect(result).toEqual({ paid: 0, skipped: 0 })
    expect(stripe.calls).toHaveLength(0)
  })
})
