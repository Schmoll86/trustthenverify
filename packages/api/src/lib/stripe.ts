/**
 * StripeService — abstraction over Stripe Connect for escrow operations.
 * Real impl uses Stripe API; tests use MockStripeService.
 */

export interface StripeService {
  /** Capture funds from buyer + seller collateral. Returns Stripe PaymentIntent ID. */
  captureEscrowFunds(params: {
    buyerAmountCents: number
    sellerCollateralCents: number
    escrowId: string
    metadata?: Record<string, string>
  }): Promise<{ stripeEscrowId: string }>

  /** Release funds to seller (buyer payment + seller collateral returned). */
  releaseFunds(params: {
    stripeEscrowId: string
    sellerAmountCents: number
  }): Promise<void>

  /** Burn both deposits (send to protocol treasury / cancel). */
  burnFunds(params: {
    stripeEscrowId: string
  }): Promise<void>

  /** Refund buyer, burn seller collateral (timeout scenario). */
  refundBuyerAndBurnCollateral(params: {
    stripeEscrowId: string
    buyerRefundCents: number
  }): Promise<void>
}

/**
 * Real Stripe Connect implementation.
 * Uses PaymentIntents with manual capture for escrow holds.
 */
export class RealStripeService implements StripeService {
  private secretKey: string

  constructor(secretKey: string) {
    this.secretKey = secretKey
  }

  private async stripeRequest(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body).toString(),
    })
    if (!res.ok) {
      const err = await res.json() as { error?: { message?: string } }
      throw new Error(`Stripe error: ${err.error?.message ?? res.statusText}`)
    }
    return res.json() as Promise<Record<string, unknown>>
  }

  async captureEscrowFunds(params: {
    buyerAmountCents: number
    sellerCollateralCents: number
    escrowId: string
    metadata?: Record<string, string>
  }): Promise<{ stripeEscrowId: string }> {
    const totalCents = params.buyerAmountCents + params.sellerCollateralCents
    const result = await this.stripeRequest('/payment_intents', {
      amount: String(totalCents),
      currency: 'usd',
      capture_method: 'manual',
      confirm: 'true',
      'metadata[escrow_id]': params.escrowId,
      'metadata[type]': 'escrow_hold',
      ...params.metadata,
    })

    // Capture immediately after confirmation
    const piId = result.id as string
    await this.stripeRequest(`/payment_intents/${piId}/capture`, {})

    return { stripeEscrowId: piId }
  }

  async releaseFunds(params: {
    stripeEscrowId: string
    sellerAmountCents: number
  }): Promise<void> {
    await this.stripeRequest('/transfers', {
      amount: String(params.sellerAmountCents),
      currency: 'usd',
      'metadata[stripe_escrow_id]': params.stripeEscrowId,
      'metadata[type]': 'escrow_release',
    })
  }

  async burnFunds(params: {
    stripeEscrowId: string
  }): Promise<void> {
    // In burn mode, funds stay with platform (no transfer, no refund)
    // Log for audit trail
    void params.stripeEscrowId
  }

  async refundBuyerAndBurnCollateral(params: {
    stripeEscrowId: string
    buyerRefundCents: number
  }): Promise<void> {
    await this.stripeRequest('/refunds', {
      payment_intent: params.stripeEscrowId,
      amount: String(params.buyerRefundCents),
      'metadata[type]': 'escrow_timeout_refund',
    })
  }
}
