import { describe, it, expect } from 'vitest'
import {
  generateKeypair,
  createAgent,
  TrustProtocol,
} from '@trustthenverify/sdk'

const API_URL = process.env.E2E_API_URL ?? 'https://sandbox.trustthenverify.com/v2'
const SANDBOX_KEY = process.env.E2E_SANDBOX_KEY ?? ''

describe('E2E dispute arbitration', { timeout: 30_000 }, () => {
  const buyer = generateKeypair()
  const seller = generateKeypair()

  let buyerProto: TrustProtocol
  let sellerProto: TrustProtocol

  // ── Escrow 1: arbitrate mode (default) — buyer disputes active escrow ──────

  let escrowIdArbitrate: string

  it('registers buyer', async () => {
    await createAgent({
      publicKey: buyer.publicKey,
      privateKey: buyer.privateKey,
      name: 'e2e-dispute-buyer',
      capabilities: ['purchase'],
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })

    buyerProto = new TrustProtocol({
      publicKey: buyer.publicKey,
      privateKey: buyer.privateKey,
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })
  })

  it('registers seller', async () => {
    await createAgent({
      publicKey: seller.publicKey,
      privateKey: seller.privateKey,
      name: 'e2e-dispute-seller',
      capabilities: ['web-search'],
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })

    sellerProto = new TrustProtocol({
      publicKey: seller.publicKey,
      privateKey: seller.privateKey,
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })
  })

  it('proposes escrow with default arbitrate mode', async () => {
    const escrow = await buyerProto.proposeEscrow({
      seller: seller.publicKey,
      amountCents: 500,
      collateralRatio: 0.5,
      taskSpec: { query: 'summarize quantum computing' },
      verificationMethod: 'buyer_confirm',
      timeoutSeconds: 3600,
    })
    expect(escrow.status).toBe('proposed')
    expect(escrow.disputeResolution).toBe('arbitrate')
    escrowIdArbitrate = escrow.id
  })

  it('seller accepts arbitrate escrow', async () => {
    expect(escrowIdArbitrate).toBeTruthy()
    const escrow = await sellerProto.acceptEscrow(escrowIdArbitrate)
    expect(escrow.status).toBe('active')
  })

  it('buyer disputes active escrow → LLM arbitrates', async () => {
    expect(escrowIdArbitrate).toBeTruthy()
    // Will either succeed (LLM rules) or fail (502 if LLM unavailable)
    try {
      const escrow = await buyerProto.disputeEscrow(
        escrowIdArbitrate,
        'Seller has not delivered anything and is unresponsive',
      )
      // LLM ruled or dispute pending
      expect(['failed', 'released', 'disputed']).toContain(escrow.status)

      if (escrow.status === 'failed' || escrow.status === 'released') {
        const fetched = await buyerProto.getEscrow(escrowIdArbitrate)
        expect(fetched.status).toBe(escrow.status)
        expect(fetched.completedAt).toBeTruthy()
      }
    } catch (err: unknown) {
      // 502 is acceptable if LLM is unavailable
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toMatch(/502|ARBITRATION_FAILED/)

      const fetched = await buyerProto.getEscrow(escrowIdArbitrate)
      expect(fetched.status).toBe('disputed')
    }
  })

  // ── Escrow 2: burn mode (opt-in) — seller disputes active escrow ───────────

  let escrowIdBurn: string

  it('proposes escrow with burn mode', async () => {
    const escrow = await (buyerProto as any).post('/escrow/propose', {
      seller: seller.publicKey,
      amountCents: 200,
      sellerCollateral: 100,
      taskSpec: { query: 'write a haiku' },
      verificationMethod: 'buyer_confirm',
      timeoutSeconds: 3600,
      disputeResolution: 'burn',
    })
    expect(escrow.status).toBe('proposed')
    expect(escrow.disputeResolution).toBe('burn')
    escrowIdBurn = escrow.id
  })

  it('seller accepts burn escrow', async () => {
    expect(escrowIdBurn).toBeTruthy()
    const escrow = await sellerProto.acceptEscrow(escrowIdBurn)
    expect(escrow.status).toBe('active')
  })

  it('seller disputes burn escrow → burned', async () => {
    expect(escrowIdBurn).toBeTruthy()
    const escrow = await sellerProto.disputeEscrow(
      escrowIdBurn,
      'Buyer requirements are impossible',
    )
    expect(escrow.status).toBe('burned')
    expect(escrow.completedAt).toBeTruthy()
  })

  // ── Escrow 3: dispute after delivery ───────────────────────────────────────

  let escrowIdDelivered: string

  it('proposes escrow for post-delivery dispute', async () => {
    const escrow = await buyerProto.proposeEscrow({
      seller: seller.publicKey,
      amountCents: 300,
      collateralRatio: 0.5,
      taskSpec: { query: 'explain dark matter' },
      verificationMethod: 'buyer_confirm',
      timeoutSeconds: 3600,
    })
    expect(escrow.status).toBe('proposed')
    escrowIdDelivered = escrow.id
  })

  it('seller accepts and delivers', async () => {
    expect(escrowIdDelivered).toBeTruthy()
    const accepted = await sellerProto.acceptEscrow(escrowIdDelivered)
    expect(accepted.status).toBe('active')

    const delivered = await sellerProto.deliver(escrowIdDelivered, {
      explanation: 'Dark matter is stuff we cant see but it has gravity',
    })
    expect((delivered as any).id ?? (delivered as any).escrowId).toBe(escrowIdDelivered)
  })

  it('buyer disputes delivered escrow → arbitration', async () => {
    expect(escrowIdDelivered).toBeTruthy()
    try {
      const escrow = await buyerProto.disputeEscrow(
        escrowIdDelivered,
        'Explanation is too vague and lacks scientific rigor',
      )
      expect(['failed', 'released', 'disputed']).toContain(escrow.status)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toMatch(/502|ARBITRATION_FAILED/)

      const fetched = await buyerProto.getEscrow(escrowIdDelivered)
      expect(fetched.status).toBe('disputed')
    }
  })

  // ── Dispute routes ─────────────────────────────────────────────────────────

  it('POST /disputes/:id/ruling returns 403', async () => {
    try {
      await (buyerProto as any).post('/disputes/fake-id/ruling', { ruling: 'buyer_wins' })
      expect.fail('Should have thrown')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toMatch(/403|FORBIDDEN|not permitted/)
    }
  })
})
