import { describe, it, expect } from 'vitest'
import {
  generateKeypair,
  createAgent,
  TrustProtocol,
} from '@trustthenverify/sdk'

const API_URL = process.env.E2E_API_URL ?? 'https://sandbox.trustthenverify.com/v2'
const SANDBOX_KEY = process.env.E2E_SANDBOX_KEY ?? ''

describe('E2E smoke test — happy path', { timeout: 30_000 }, () => {
  const buyer = generateKeypair()
  const seller = generateKeypair()

  let buyerProto: TrustProtocol
  let sellerProto: TrustProtocol
  let escrowId: string
  let policyId: string
  let sellerId: string

  it('registers buyer agent', async () => {
    const agent = await createAgent({
      publicKey: buyer.publicKey,
      privateKey: buyer.privateKey,
      name: 'e2e-buyer',
      capabilities: ['purchase'],
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })
    expect(agent.publicKey).toBe(buyer.publicKey)

    buyerProto = new TrustProtocol({
      publicKey: buyer.publicKey,
      privateKey: buyer.privateKey,
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })
  })

  it('registers seller agent', async () => {
    const agent = await createAgent({
      publicKey: seller.publicKey,
      privateKey: seller.privateKey,
      name: 'e2e-seller',
      capabilities: ['web-search'],
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })
    expect(agent.publicKey).toBe(seller.publicKey)
    sellerId = agent.id

    sellerProto = new TrustProtocol({
      publicKey: seller.publicKey,
      privateKey: seller.privateKey,
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })
  })

  it('creates and activates a policy', async () => {
    const policy = await buyerProto.createPolicy({
      name: 'e2e-search-policy',
      intent: 'Return at least 3 search results, each with a title and URL.',
    })
    expect(policy.id).toBeTruthy()
    expect(policy.status).toMatch(/draft|validated/)
    policyId = policy.id

    const active = await buyerProto.activatePolicy(policyId)
    expect(active.status).toBe('active')
  })

  it('proposes escrow (buyer_confirm, no Stripe)', async () => {
    const escrow = await buyerProto.proposeEscrow({
      seller: seller.publicKey,
      amountCents: 100,
      collateralRatio: 0.5,
      taskSpec: { query: 'best AI frameworks 2025' },
      policyId,
      verificationMethod: 'buyer_confirm',
      timeoutSeconds: 3600,
    })
    expect(escrow.status).toBe('proposed')
    escrowId = escrow.id
  })

  it('seller accepts escrow', async () => {
    const escrow = await sellerProto.acceptEscrow(escrowId)
    expect(escrow.status).toBe('active')
  })

  it('seller delivers', async () => {
    const result = await sellerProto.deliver(escrowId, {
      results: [
        { title: 'PyTorch', url: 'https://pytorch.org' },
        { title: 'TensorFlow', url: 'https://tensorflow.org' },
        { title: 'JAX', url: 'https://github.com/google/jax' },
      ],
    })
    expect(result.escrowId).toBe(escrowId)
  })

  it('buyer confirms delivery — escrow released', async () => {
    const escrow = await buyerProto.confirmDelivery(escrowId)
    expect(escrow.status).toBe('released')
  })

  it('publishes attestation without error', async () => {
    const attestation = await buyerProto.publishAttestation({
      subjectId: sellerId,
      escrowId,
      outcome: 'success',
      verificationMethod: 'buyer_confirm',
    })
    expect(attestation.id).toBeTruthy()
    expect(attestation.outcome).toBe('success')
  })
})
