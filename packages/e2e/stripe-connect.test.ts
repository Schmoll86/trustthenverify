import { describe, it, expect } from 'vitest'
import {
  generateKeypair,
  createAgent,
  TrustProtocol,
} from '@trustthenverify/sdk'

const API_URL = process.env.E2E_API_URL ?? 'https://sandbox.trustthenverify.com/v2'
const SANDBOX_KEY = process.env.E2E_SANDBOX_KEY ?? ''

describe('E2E Stripe Connect — onboarding + escrow lifecycle', { timeout: 30_000 }, () => {
  const buyer = generateKeypair()
  const seller = generateKeypair()

  let buyerProto: TrustProtocol
  let sellerProto: TrustProtocol
  let escrowId: string
  let policyId: string
  let sellerId: string

  // ── Registration ──────────────────────────────────────────────────────────

  it('1. registers buyer agent', async () => {
    const agent = await createAgent({
      publicKey: buyer.publicKey,
      privateKey: buyer.privateKey,
      name: 'e2e-stripe-buyer',
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

  it('2. registers seller agent', async () => {
    const agent = await createAgent({
      publicKey: seller.publicKey,
      privateKey: seller.privateKey,
      name: 'e2e-stripe-seller',
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

  // ── Stripe Onboarding ─────────────────────────────────────────────────────

  it('3. buyer sets up Stripe customer', async () => {
    const agent = await buyerProto.setupStripeCustomer()
    expect(agent.stripeCustomerId).toBeTruthy()
  })

  it('4. buyer attaches payment method', async () => {
    const agent = await buyerProto.attachPaymentMethod('pm_sandbox_test')
    expect(agent.stripeDefaultPaymentMethod).toBe('pm_sandbox_test')
  })

  it('5. seller sets up Stripe Connect', async () => {
    const result = await sellerProto.setupStripeConnect()
    expect(result.agent.stripeConnectedAccountId).toBeTruthy()
    expect(result.onboardingUrl).toBeTruthy()
  })

  it('6. buyer stripe status shows customer but no connect', async () => {
    const status = await buyerProto.getStripeStatus()
    expect(status.hasCustomer).toBe(true)
    expect(status.hasConnectAccount).toBe(false)
  })

  it('7. seller stripe status shows connect account', async () => {
    const status = await sellerProto.getStripeStatus()
    expect(status.hasConnectAccount).toBe(true)
  })

  // ── Escrow Lifecycle with buyerPaymentMethodId ────────────────────────────

  it('8. creates and activates policy', async () => {
    // Provide formalSpec directly to guarantee 'validated' status (avoids NL translation flakiness)
    const policy = await (buyerProto as any).post('/policies', {
      name: 'e2e-stripe-policy',
      intent: 'Return at least 3 search results, each with a title and URL.',
      formalSpec: {
        version: 1,
        constraints: [
          { id: 'c1', type: 'count', target: '$.results', params: { min: 3 } },
          { id: 'c2', type: 'exists', target: '$.results[*].title', params: {} },
          { id: 'c3', type: 'exists', target: '$.results[*].url', params: {} },
        ],
      },
    })
    expect(policy.id).toBeTruthy()
    expect(policy.status).toBe('validated')
    policyId = policy.id

    const active = await buyerProto.activatePolicy(policyId)
    expect(active.status).toBe('active')
  })

  it('9. proposes escrow with buyerPaymentMethodId', async () => {
    const escrow = await buyerProto.proposeEscrow({
      seller: seller.publicKey,
      amountCents: 200,
      collateralRatio: 0.5,
      taskSpec: { query: 'top AI frameworks 2025' },
      policyId,
      verificationMethod: 'buyer_confirm',
      timeoutSeconds: 3600,
      buyerPaymentMethodId: 'pm_sandbox_test',
    })
    expect(escrow.status).toBe('proposed')
    escrowId = escrow.id
  })

  it('10. seller accepts — active (sandbox skips Stripe)', async () => {
    const escrow = await sellerProto.acceptEscrow(escrowId)
    expect(escrow.status).toBe('active')
  })

  it('11. seller delivers', async () => {
    const result = await sellerProto.deliver(escrowId, {
      results: [
        { title: 'PyTorch', url: 'https://pytorch.org' },
        { title: 'TensorFlow', url: 'https://tensorflow.org' },
        { title: 'JAX', url: 'https://github.com/google/jax' },
      ],
    })
    // For buyer_confirm, deliver returns the Escrow object (id), not VerificationResult (escrowId)
    expect((result as any).id ?? (result as any).escrowId).toBe(escrowId)
  })

  it('12. buyer confirms — released with sandbox_mock stripe id', async () => {
    const escrow = await buyerProto.confirmDelivery(escrowId)
    expect(escrow.status).toBe('released')
    expect(escrow.stripeEscrowId).toBe('sandbox_mock')
  })

  it('13. publishes attestation (full lifecycle complete)', async () => {
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
