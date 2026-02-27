/**
 * E2E tests for Phase 3/5/6 completion — sandbox environment.
 *
 * Tests:
 * 1. Attestation query flow
 * 2. suggestCollateral with attestation data
 * 3. Argus refinement trigger + status polling
 * 4. Oracle lifecycle: join pool → vote → consensus
 * 5. Oracle earnings query
 * 6. Marketplace listing
 */

import { describe, it, expect } from 'vitest'
import {
  generateKeypair,
  createAgent,
  TrustProtocol,
  queryAttestations,
  listMarketplacePolicies,
} from '@trustthenverify/sdk'

const API_URL = process.env.E2E_API_URL ?? 'https://sandbox.trustthenverify.com/v2'
const SANDBOX_KEY = process.env.E2E_SANDBOX_KEY ?? ''

function makeProto(kp: ReturnType<typeof generateKeypair>): TrustProtocol {
  return new TrustProtocol({
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    apiUrl: API_URL,
    sandbox: true,
    sandboxKey: SANDBOX_KEY,
  })
}

async function register(name: string, caps: string[] = []) {
  const kp = generateKeypair()
  await createAgent({
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    name,
    capabilities: caps,
    apiUrl: API_URL,
    sandbox: true,
    sandboxKey: SANDBOX_KEY,
  })
  return { kp, proto: makeProto(kp) }
}

// ── Phase 5: Attestation query flow ─────────────────────────────────────────

describe('Phase 5 — Attestation query', { timeout: 30_000 }, () => {
  let buyerProto: TrustProtocol
  let sellerPubkey: string

  it('setup: register buyer + seller', async () => {
    const buyer = await register('e2e-attest-buyer', ['purchase'])
    buyerProto = buyer.proto
    const seller = await register('e2e-attest-seller', ['web-search'])
    sellerPubkey = seller.kp.publicKey
  })

  it('publish attestation', async () => {
    const att = await buyerProto.publishAttestation({
      subjectId: sellerPubkey,
      outcome: 'success',
      verificationMethod: 'buyer_confirm',
    })
    expect(att.id).toBeDefined()
    expect(att.outcome).toBe('success')
  })

  it('query attestations by pubkey', async () => {
    const atts = await queryAttestations(sellerPubkey, { apiUrl: API_URL })
    expect(atts.length).toBeGreaterThanOrEqual(1)
    expect(atts[0].outcome).toBe('success')
  })

  it('suggestCollateral uses attestation data', async () => {
    const suggestion = await buyerProto.suggestCollateral(sellerPubkey, 10000)
    expect(suggestion.dataPoints).toBeGreaterThanOrEqual(1)
    expect(suggestion.suggestedRatio).toBeLessThan(0.5) // good history → lower collateral
  })
})

// ── Phase 3: Argus refinement ───────────────────────────────────────────────

describe('Phase 3 — Argus refinement', { timeout: 60_000 }, () => {
  let proto: TrustProtocol
  let policyId: string

  it('setup: register agent + create policy', async () => {
    const agent = await register('e2e-argus', ['policy-author'])
    proto = agent.proto

    const policy = await proto.createPolicy({
      name: 'e2e-argus-test',
      intent: 'Return at least 3 search results with URLs',
    })
    expect(policy.id).toBeDefined()
    policyId = policy.id
  })

  it('trigger refinement', async () => {
    const result = await proto.refinePolicy(policyId, { budget: 2 })
    expect(result.status).toBe('running')
    expect(result.refinementId).toBeDefined()
  })

  it('poll refinement status', async () => {
    // Just check it returns a valid status (may still be running)
    const status = await proto.refinementStatus(policyId)
    expect(['running', 'complete']).toContain(status.status)
    expect(typeof status.exploitsFound).toBe('number')
  })
})

// ── Phase 6: Oracle lifecycle ───────────────────────────────────────────────

describe('Phase 6 — Oracle pool + earnings', { timeout: 30_000 }, () => {
  let oracleProto: TrustProtocol

  it('setup: register oracle agent', async () => {
    const oracle = await register('e2e-oracle', ['verification', 'web-search'])
    oracleProto = oracle.proto
  })

  it('join oracle pool', async () => {
    const entry = await oracleProto.joinOraclePool({ capabilities: ['verification'] })
    expect(entry.status).toBe('active')
    expect(entry.capabilities).toContain('verification')
  })

  it('check oracle status', async () => {
    const status = await oracleProto.getOracleStatus()
    expect(status.status).toBe('active')
    expect(status.tasksCompleted).toBe(0)
  })

  it('check oracle assignments (should be empty)', async () => {
    const assignments = await oracleProto.getOracleAssignments()
    expect(assignments).toEqual([])
  })

  it('check oracle earnings (should be zero)', async () => {
    const earnings = await oracleProto.getOracleEarnings()
    expect(earnings.totalCents).toBe(0)
    expect(earnings.paymentCount).toBe(0)
  })

  it('withdraw from oracle pool', async () => {
    const entry = await oracleProto.withdrawFromOraclePool()
    expect(entry.status).toBe('withdrawn')
  })
})

// ── Phase 3: Marketplace ────────────────────────────────────────────────────

describe('Phase 3 — Marketplace', { timeout: 15_000 }, () => {
  it('list marketplace policies (may be empty)', async () => {
    const policies = await listMarketplacePolicies({ apiUrl: API_URL })
    expect(Array.isArray(policies)).toBe(true)
  })
})
