import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockStripe } from './helpers/mock-stripe'
import { createMockOnchain } from './helpers/mock-onchain'

let mockDb: MockDb

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

import { handleEscrowTimeout, handleOnchainFunding } from '../cron/escrow-timeout'

const mockStripe = createMockStripe()
const mockOnchainBothFunded = createMockOnchain({ fundingState: 'active' })
const mockOnchainPartial = createMockOnchain({ fundingState: 'buyer_funded' })

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'test-gateway-key',
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_mock',
  AI: { run: async () => ({}) },
  QUEUE: { send: async () => {} },
}

describe('Cron: escrow timeout', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
  })

  it('expires accepted on-chain escrows past funding window', async () => {
    const pastExpiry = new Date(Date.now() - 60000).toISOString()
    mockDb.seedTable('escrows', [{
      id: 'esc-accepted-expired',
      buyer_id: 'b',
      seller_id: 's',
      amount_cents: 1000,
      seller_collateral: 100,
      status: 'accepted',
      funding_mode: 'onchain',
      contract_address: '0x' + 'aa'.repeat(20),
      expires_at: pastExpiry,
      timeout_seconds: 3600,
    }])

    const mockOnchain = createMockOnchain()
    const result = await handleEscrowTimeout(env, mockStripe, mockOnchain)

    expect(result.processed).toBe(1)
    const rows = mockDb.getTable('escrows').rows
    expect(rows[0].status).toBe('expired')
    expect(mockOnchain.calls.some(c => c.method === 'triggerTimeout')).toBe(true)
  })

  it('still expires stripe escrows as before', async () => {
    const pastExpiry = new Date(Date.now() - 60000).toISOString()
    mockDb.seedTable('escrows', [{
      id: 'esc-stripe-expired',
      buyer_id: 'b',
      seller_id: 's',
      amount_cents: 1000,
      seller_collateral: 100,
      status: 'active',
      funding_mode: 'stripe',
      stripe_escrow_id: 'pi_test',
      expires_at: pastExpiry,
      timeout_seconds: 3600,
    }])

    const result = await handleEscrowTimeout(env, mockStripe)
    expect(result.processed).toBe(1)
    expect(mockStripe.calls[0].method).toBe('refundBuyerAndBurnCollateral')
  })

  it('does not expire non-expired escrows', async () => {
    const futureExpiry = new Date(Date.now() + 3600000).toISOString()
    mockDb.seedTable('escrows', [{
      id: 'esc-not-expired',
      buyer_id: 'b',
      seller_id: 's',
      amount_cents: 1000,
      status: 'active',
      funding_mode: 'stripe',
      expires_at: futureExpiry,
    }])

    const result = await handleEscrowTimeout(env, mockStripe)
    expect(result.processed).toBe(0)
  })
})

describe('Cron: on-chain funding check', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    mockOnchainBothFunded.reset()
    mockOnchainPartial.reset()
  })

  it('activates fully funded escrows', async () => {
    const futureExpiry = new Date(Date.now() + 1800000).toISOString()
    mockDb.seedTable('escrows', [{
      id: 'esc-funded',
      buyer_id: 'b',
      seller_id: 's',
      amount_cents: 1000,
      seller_collateral: 100,
      status: 'accepted',
      funding_mode: 'onchain',
      contract_address: '0x' + 'aa'.repeat(20),
      buyer_funded: false,
      seller_funded: false,
      expires_at: futureExpiry,
      timeout_seconds: 3600,
    }])

    const result = await handleOnchainFunding(env, mockOnchainBothFunded)
    expect(result.activated).toBe(1)

    const row = mockDb.getTable('escrows').rows[0]
    expect(row.status).toBe('active')
    expect(row.buyer_funded).toBe(true)
    expect(row.seller_funded).toBe(true)
    expect(row.funded_at).toBeTruthy()
  })

  it('updates partial funding without activating', async () => {
    const futureExpiry = new Date(Date.now() + 1800000).toISOString()
    mockDb.seedTable('escrows', [{
      id: 'esc-partial',
      buyer_id: 'b',
      seller_id: 's',
      amount_cents: 1000,
      seller_collateral: 100,
      status: 'accepted',
      funding_mode: 'onchain',
      contract_address: '0x' + 'bb'.repeat(20),
      buyer_funded: false,
      seller_funded: false,
      expires_at: futureExpiry,
      timeout_seconds: 3600,
    }])

    const result = await handleOnchainFunding(env, mockOnchainPartial)
    expect(result.activated).toBe(0)

    const row = mockDb.getTable('escrows').rows[0]
    expect(row.status).toBe('accepted')  // unchanged
    expect(row.buyer_funded).toBe(true)   // updated
    expect(row.seller_funded).toBe(false) // still waiting
  })

  it('skips stripe escrows', async () => {
    const futureExpiry = new Date(Date.now() + 1800000).toISOString()
    mockDb.seedTable('escrows', [{
      id: 'esc-stripe-skip',
      buyer_id: 'b',
      seller_id: 's',
      amount_cents: 1000,
      status: 'accepted',
      funding_mode: 'stripe',
      expires_at: futureExpiry,
    }])

    const result = await handleOnchainFunding(env, mockOnchainBothFunded)
    expect(result.activated).toBe(0)
    expect(mockOnchainBothFunded.calls.length).toBe(0)
  })

  it('skips escrows without contract address', async () => {
    const futureExpiry = new Date(Date.now() + 1800000).toISOString()
    mockDb.seedTable('escrows', [{
      id: 'esc-no-addr',
      buyer_id: 'b',
      seller_id: 's',
      amount_cents: 1000,
      status: 'accepted',
      funding_mode: 'onchain',
      contract_address: null,
      expires_at: futureExpiry,
    }])

    const result = await handleOnchainFunding(env, mockOnchainBothFunded)
    expect(result.activated).toBe(0)
  })
})
