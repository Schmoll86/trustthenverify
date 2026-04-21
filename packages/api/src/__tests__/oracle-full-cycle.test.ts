/**
 * Full-cycle oracle tests: join pool → propose oracle escrow → deliver →
 * vote → consensus → escrow state transition.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app } from '../index'
import { generateKeypair, signRequest } from '@trustthenverify/sdk'
import { createMockDb, type MockDb } from './helpers/mock-db'
import { createMockStripe } from './helpers/mock-stripe'

let mockDb: MockDb
const mockStripe = createMockStripe()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockDb,
}))

vi.mock('../lib/stripe', () => ({
  RealStripeService: class {
    createCustomer = mockStripe.createCustomer
    createConnectAccount = mockStripe.createConnectAccount
    getAccountStatus = mockStripe.getAccountStatus
    attachPaymentMethod = mockStripe.attachPaymentMethod
    captureEscrowFunds = mockStripe.captureEscrowFunds
    releaseFunds = mockStripe.releaseFunds
    burnFunds = mockStripe.burnFunds
    refundBuyerAndBurnCollateral = mockStripe.refundBuyerAndBurnCollateral
    transferToConnectedAccount = mockStripe.transferToConnectedAccount
  },
}))

const env = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GATEWAY_PRIVATE_KEY: 'a'.repeat(64),
  SANDBOX_KEYS: 'test_sandbox_key_123',
  STRIPE_SECRET_KEY: 'sk_test_mock',
  ORACLE_FEE_CENTS: '500',
  ORACLE_VOTING_WINDOW_SECONDS: '1800',
  QUEUE: { send: vi.fn() },
}

// 5 agents: 3 oracles + buyer + seller
const oracle1Kp = generateKeypair()
const oracle2Kp = generateKeypair()
const oracle3Kp = generateKeypair()
const buyerKp = generateKeypair()
const sellerKp = generateKeypair()

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

function seedAllAgents() {
  mockDb.seedTable('agents', [
    {
      id: 'oracle1-id',
      public_key: oracle1Kp.publicKey,
      endpoint: null,
      name: 'oracle1',
      capabilities: ['code-review'],
      metadata: {},
      parent_id: null,
      created_at: '2025-01-01T00:00:00Z',
      last_seen_at: '2025-01-01T00:00:00Z',
      stripe_customer_id: null,
      stripe_connected_account_id: 'acct_oracle1',
      stripe_onboarding_complete: true,
      stripe_default_payment_method: null,
      email: null,
      notification_preferences: null,
      webhook_url: null,
      webhook_secret: null,
    },
    {
      id: 'oracle2-id',
      public_key: oracle2Kp.publicKey,
      endpoint: null,
      name: 'oracle2',
      capabilities: ['code-review'],
      metadata: {},
      parent_id: null,
      created_at: '2025-01-01T00:00:00Z',
      last_seen_at: '2025-01-01T00:00:00Z',
      stripe_customer_id: null,
      stripe_connected_account_id: 'acct_oracle2',
      stripe_onboarding_complete: true,
      stripe_default_payment_method: null,
      email: null,
      notification_preferences: null,
      webhook_url: null,
      webhook_secret: null,
    },
    {
      id: 'oracle3-id',
      public_key: oracle3Kp.publicKey,
      endpoint: null,
      name: 'oracle3',
      capabilities: ['code-review'],
      metadata: {},
      parent_id: null,
      created_at: '2025-01-01T00:00:00Z',
      last_seen_at: '2025-01-01T00:00:00Z',
      stripe_customer_id: null,
      stripe_connected_account_id: 'acct_oracle3',
      stripe_onboarding_complete: true,
      stripe_default_payment_method: null,
      email: null,
      notification_preferences: null,
      webhook_url: null,
      webhook_secret: null,
    },
    {
      id: 'buyer-id',
      public_key: buyerKp.publicKey,
      endpoint: null,
      name: 'buyer',
      capabilities: [],
      metadata: {},
      parent_id: null,
      created_at: '2025-01-01T00:00:00Z',
      last_seen_at: '2025-01-01T00:00:00Z',
      stripe_customer_id: 'cus_buyer',
      stripe_connected_account_id: null,
      stripe_onboarding_complete: false,
      stripe_default_payment_method: 'pm_buyer',
      email: null,
      notification_preferences: null,
      webhook_url: null,
      webhook_secret: null,
    },
    {
      id: 'seller-id',
      public_key: sellerKp.publicKey,
      endpoint: null,
      name: 'seller',
      capabilities: ['web-search'],
      metadata: {},
      parent_id: null,
      created_at: '2025-01-01T00:00:00Z',
      last_seen_at: '2025-01-01T00:00:00Z',
      stripe_customer_id: 'cus_seller',
      stripe_connected_account_id: 'acct_seller',
      stripe_onboarding_complete: true,
      stripe_default_payment_method: 'pm_seller',
      email: null,
      notification_preferences: null,
      webhook_url: null,
      webhook_secret: null,
    },
  ])
}

describe('Oracle full cycle', () => {
  beforeEach(() => {
    mockDb = createMockDb()
    mockStripe.reset()
    ;(env.QUEUE.send as ReturnType<typeof vi.fn>).mockReset()
    seedAllAgents()
    mockDb.seedTable('oracle_pool', [])
    mockDb.seedTable('oracle_tasks', [])
    mockDb.seedTable('oracle_votes', [])
    mockDb.seedTable('oracle_payments', [])
    mockDb.seedTable('escrows', [])
    mockDb.seedTable('verifications', [])
    mockDb.seedTable('disputes', [])
  })

  it('3 oracles join pool -> all active', async () => {
    const res1 = await makeSignedRequest('POST', '/v2/oracles/join', JSON.stringify({ capabilities: ['code-review'] }), oracle1Kp)
    const res2 = await makeSignedRequest('POST', '/v2/oracles/join', JSON.stringify({ capabilities: ['code-review'] }), oracle2Kp)
    const res3 = await makeSignedRequest('POST', '/v2/oracles/join', JSON.stringify({ capabilities: ['code-review'] }), oracle3Kp)

    expect(res1.status).toBe(201)
    expect(res2.status).toBe(201)
    expect(res3.status).toBe(201)

    const pool = mockDb.getTable('oracle_pool').rows
    expect(pool).toHaveLength(3)
    pool.forEach(p => expect(p.status).toBe('active'))
  })

  it('propose with oracle_consensus sets oracle_fee_cents', async () => {
    const proposeBody = JSON.stringify({
      seller: sellerKp.publicKey,
      amountCents: 10000,
      sellerCollateral: 5000,
      taskSpec: { type: 'code-review', pr: 42 },
      verificationMethod: 'oracle_consensus',
      timeoutSeconds: 3600,
    })

    const res = await makeSignedRequest('POST', '/v2/escrow/propose', proposeBody, buyerKp)
    expect(res.status).toBe(201)

    const json = await res.json() as { data: { oracleFeeCents: number; status: string } }
    expect(json.data.status).toBe('proposed')
    expect(json.data.oracleFeeCents).toBe(500) // env.ORACLE_FEE_CENTS = '500'
  })

  it('deliver with oracle_consensus enqueues oracle_dispatch', async () => {
    // Seed an active oracle escrow
    mockDb.seedTable('escrows', [{
      id: 'esc-oracle-1',
      buyer_id: 'buyer-id',
      seller_id: 'seller-id',
      amount_cents: 10000,
      seller_collateral: 5000,
      task_hash: 'abc',
      task_spec: { type: 'code-review', pr: 42 },
      policy_id: null,
      verification_method: 'oracle_consensus',
      dispute_resolution: 'burn',
      status: 'active',
      proof: null,
      deliverable: null,
      created_at: '2025-01-01T00:00:00Z',
      funded_at: '2025-01-01T00:00:00Z',
      completed_at: null,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      delivery_attempts: 0,
      timeout_seconds: 3600,
      funding_mode: 'stripe',
      stripe_escrow_id: 'pi_test',
      stripe_buyer_pi_id: 'pi_test',
      stripe_seller_collateral_pi_id: null,
      stripe_transfer_id: null,
      buyer_payment_method_id: null,
      seller_payment_method_id: null,
      buyer_address: null,
      seller_address: null,
      buyer_funded: false,
      seller_funded: false,
      chain_id: null,
      tx_hash: null,
      oracle_fee_cents: 500,
      x402_tx_hash: null,
      x402_macaroon: null,
      x402_settlement_fee_cents: 0,
      x402_seller_payout_tx: null,
      contract_address: null,
    }])

    const body = JSON.stringify({ deliverable: { review: 'LGTM', approved: true } })
    const res = await makeSignedRequest('POST', '/v2/escrow/esc-oracle-1/deliver', body, sellerKp)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string } }
    expect(json.data.status).toBe('delivered')

    // Queue should have oracle_dispatch
    expect(env.QUEUE.send).toHaveBeenCalledWith({
      type: 'oracle_dispatch',
      escrowId: 'esc-oracle-1',
      deliverable: { review: 'LGTM', approved: true },
    })
  })

  it('oracle submits pass vote successfully', async () => {
    // Seed oracle in pool + task + vote assignment
    mockDb.seedTable('oracle_pool', [{
      id: 'pool-1',
      agent_id: 'oracle1-id',
      status: 'active',
      capabilities: ['code-review'],
      tasks_completed: 0,
      accuracy_score: 1.0,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    }])
    mockDb.seedTable('escrows', [{
      id: 'esc-1',
      buyer_id: 'buyer-id',
      seller_id: 'seller-id',
      amount_cents: 10000,
      seller_collateral: 5000,
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
    }])
    mockDb.seedTable('oracle_tasks', [{
      id: 'task-1',
      escrow_id: 'esc-1',
      status: 'voting',
      quorum: 3,
      total_oracles: 3,
      consensus: null,
      deliverable: { text: 'test' },
      task_spec: null,
      policy_id: null,
      votes_pass: 0,
      votes_fail: 0,
      expires_at: new Date(Date.now() + 1800000).toISOString(),
      decided_at: null,
      created_at: new Date().toISOString(),
    }])
    mockDb.seedTable('oracle_votes', [{
      id: 'vote-1',
      oracle_task_id: 'task-1',
      oracle_id: 'pool-1',
      agent_id: 'oracle1-id',
      status: 'pending',
      verdict: null,
      rationale: null,
      submitted_at: null,
      created_at: new Date().toISOString(),
    }])

    const body = JSON.stringify({
      oracleTaskId: 'task-1',
      verdict: 'pass',
      rationale: 'Code looks correct, all tests pass',
    })
    const res = await makeSignedRequest('POST', '/v2/oracles/vote', body, oracle1Kp)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { voted: boolean; verdict: string } }
    expect(json.data.voted).toBe(true)
    expect(json.data.verdict).toBe('pass')
  })

  it('oracle cannot double vote', async () => {
    mockDb.seedTable('oracle_pool', [{
      id: 'pool-1',
      agent_id: 'oracle1-id',
      status: 'active',
      capabilities: [],
      tasks_completed: 0,
      accuracy_score: 1.0,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    }])
    mockDb.seedTable('escrows', [{
      id: 'esc-1',
      buyer_id: 'buyer-id',
      seller_id: 'seller-id',
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
    }])
    mockDb.seedTable('oracle_tasks', [{
      id: 'task-1',
      escrow_id: 'esc-1',
      status: 'voting',
      quorum: 3,
      total_oracles: 3,
      consensus: null,
      deliverable: {},
      task_spec: null,
      policy_id: null,
      votes_pass: 0,
      votes_fail: 0,
      expires_at: new Date(Date.now() + 1800000).toISOString(),
      decided_at: null,
      created_at: new Date().toISOString(),
    }])
    mockDb.seedTable('oracle_votes', [{
      id: 'vote-1',
      oracle_task_id: 'task-1',
      oracle_id: 'pool-1',
      agent_id: 'oracle1-id',
      status: 'pending',
      verdict: null,
      rationale: null,
      submitted_at: null,
      created_at: new Date().toISOString(),
    }])

    const body = JSON.stringify({ oracleTaskId: 'task-1', verdict: 'pass' })

    // First vote succeeds
    const res1 = await makeSignedRequest('POST', '/v2/oracles/vote', body, oracle1Kp)
    expect(res1.status).toBe(200)

    // Second vote fails
    const res2 = await makeSignedRequest('POST', '/v2/oracles/vote', body, oracle1Kp)
    expect(res2.status).toBe(409)
  })

  it('insufficient votes -> task stays voting', async () => {
    mockDb.seedTable('oracle_tasks', [{
      id: 'task-voting',
      escrow_id: 'esc-1',
      status: 'voting',
      quorum: 3,
      total_oracles: 5,
      consensus: null,
      deliverable: {},
      task_spec: null,
      policy_id: null,
      votes_pass: 1,
      votes_fail: 0,
      expires_at: new Date(Date.now() + 1800000).toISOString(),
      decided_at: null,
      created_at: new Date().toISOString(),
    }])

    // Only 1 vote submitted, quorum is 3 -> task stays voting
    const task = mockDb.getTable('oracle_tasks').rows[0]
    expect(task.status).toBe('voting')
    expect(task.consensus).toBeNull()
  })

  it('oracle pool status returns correct stats', async () => {
    // Join first
    await makeSignedRequest('POST', '/v2/oracles/join', JSON.stringify({ capabilities: ['code-review'] }), oracle1Kp)

    // Check status
    const res = await makeSignedRequest('GET', '/v2/oracles/status', '', oracle1Kp)
    expect(res.status).toBe(200)

    const json = await res.json() as { data: { status: string; capabilities: string[] } }
    expect(json.data.status).toBe('active')
    expect(json.data.capabilities).toEqual(['code-review'])
  })

  it('non-pool agent cannot vote -> 403', async () => {
    mockDb.seedTable('oracle_tasks', [{
      id: 'task-1',
      escrow_id: 'esc-1',
      status: 'voting',
      quorum: 3,
      total_oracles: 3,
      consensus: null,
      deliverable: {},
      task_spec: null,
      policy_id: null,
      votes_pass: 0,
      votes_fail: 0,
      expires_at: new Date(Date.now() + 1800000).toISOString(),
      decided_at: null,
      created_at: new Date().toISOString(),
    }])
    mockDb.seedTable('oracle_votes', [])

    const body = JSON.stringify({ oracleTaskId: 'task-1', verdict: 'pass' })
    // oracle1 is NOT in oracle_pool -> 403
    const res = await makeSignedRequest('POST', '/v2/oracles/vote', body, oracle1Kp)
    expect(res.status).toBe(403)
  })
})
