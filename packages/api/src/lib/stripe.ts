/**
 * StripeService — abstraction over Stripe Connect for escrow operations.
 * Real impl uses Stripe API; tests use MockStripeService.
 *
 * Game-theoretic parity with on-chain mode:
 *   Released  → buyer amount → seller, seller collateral refunded
 *   Failed    → buyer refunded, seller collateral kept (platform revenue)
 *   Burned    → both kept (platform revenue)
 */

// ── Onboarding ──────────────────────────────────────────────────────────────

export interface StripeService {
  /** Create a Stripe Customer for a buyer agent. */
  createCustomer(params: {
    agentId: string
    name?: string
    metadata?: Record<string, string>
  }): Promise<{ customerId: string }>

  /** Create a Stripe Express connected account for a seller + return onboarding URL. */
  createConnectAccount(params: {
    agentId: string
    returnUrl: string
    refreshUrl: string
    metadata?: Record<string, string>
  }): Promise<{ accountId: string; onboardingUrl: string }>

  /** Check whether a connected account has completed onboarding. */
  getAccountStatus(accountId: string): Promise<{
    chargesEnabled: boolean
    payoutsEnabled: boolean
    detailsSubmitted: boolean
  }>

  /** Create a SetupIntent for a Customer (card collection without immediate charge). */
  createSetupIntent(params: {
    customerId: string
    metadata?: Record<string, string>
  }): Promise<{ setupIntentId: string; clientSecret: string }>

  /** Attach a payment method to a Customer. */
  attachPaymentMethod(params: {
    customerId: string
    paymentMethodId: string
  }): Promise<{ paymentMethodId: string }>

  // ── Escrow lifecycle ────────────────────────────────────────────────────

  /** Capture buyer payment + optional seller collateral. Two separate PIs. */
  captureEscrowFunds(params: {
    buyerAmountCents: number
    sellerCollateralCents: number
    escrowId: string
    buyerCustomerId: string
    buyerPaymentMethodId: string
    sellerCustomerId?: string
    sellerPaymentMethodId?: string
    metadata?: Record<string, string>
  }): Promise<{
    stripeBuyerPiId: string
    stripeSellerCollateralPiId: string | null
  }>

  /** Release buyer payment to seller's connected account. Refund seller collateral. */
  releaseFunds(params: {
    stripeBuyerPiId: string
    sellerConnectedAccountId: string
    sellerAmountCents: number
    stripeSellerCollateralPiId?: string
  }): Promise<{ transferId: string }>

  /** Burn both deposits — keep on platform (no transfer, no refund). */
  burnFunds(params: {
    stripeBuyerPiId: string
    stripeSellerCollateralPiId?: string
  }): Promise<void>

  /** Refund buyer, burn seller collateral (timeout/fail scenario). */
  refundBuyerAndBurnCollateral(params: {
    stripeBuyerPiId: string
    buyerRefundCents: number
    stripeSellerCollateralPiId?: string
  }): Promise<void>
}

/**
 * Real Stripe Connect implementation.
 * Separate Charges and Transfers pattern with Express accounts.
 */
export class RealStripeService implements StripeService {
  private secretKey: string

  constructor(secretKey: string) {
    this.secretKey = secretKey
  }

  private async stripePost(
    path: string,
    body: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey
    }
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(body).toString(),
    })
    if (!res.ok) {
      const err = await res.json() as { error?: { message?: string } }
      throw new Error(`Stripe error: ${err.error?.message ?? res.statusText}`)
    }
    return res.json() as Promise<Record<string, unknown>>
  }

  private async stripeGet(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.secretKey}`,
      },
    })
    if (!res.ok) {
      const err = await res.json() as { error?: { message?: string } }
      throw new Error(`Stripe error: ${err.error?.message ?? res.statusText}`)
    }
    return res.json() as Promise<Record<string, unknown>>
  }

  // ── Onboarding ──────────────────────────────────────────────────────────

  async createCustomer(params: {
    agentId: string
    name?: string
    metadata?: Record<string, string>
  }): Promise<{ customerId: string }> {
    const body: Record<string, string> = {
      'metadata[agent_id]': params.agentId,
      'metadata[platform]': 'trustthenverify',
    }
    if (params.name) body.name = params.name
    if (params.metadata) {
      for (const [k, v] of Object.entries(params.metadata)) {
        body[`metadata[${k}]`] = v
      }
    }
    const result = await this.stripePost('/customers', body)
    return { customerId: result.id as string }
  }

  async createConnectAccount(params: {
    agentId: string
    returnUrl: string
    refreshUrl: string
    metadata?: Record<string, string>
  }): Promise<{ accountId: string; onboardingUrl: string }> {
    // 1. Create Express account
    const accountBody: Record<string, string> = {
      type: 'express',
      'capabilities[transfers][requested]': 'true',
      'metadata[agent_id]': params.agentId,
      'metadata[platform]': 'trustthenverify',
    }
    if (params.metadata) {
      for (const [k, v] of Object.entries(params.metadata)) {
        accountBody[`metadata[${k}]`] = v
      }
    }
    const account = await this.stripePost('/accounts', accountBody)
    const accountId = account.id as string

    // 2. Create onboarding link
    const link = await this.stripePost('/account_links', {
      account: accountId,
      type: 'account_onboarding',
      return_url: params.returnUrl,
      refresh_url: params.refreshUrl,
    })

    return { accountId, onboardingUrl: link.url as string }
  }

  async getAccountStatus(accountId: string): Promise<{
    chargesEnabled: boolean
    payoutsEnabled: boolean
    detailsSubmitted: boolean
  }> {
    const account = await this.stripeGet(`/accounts/${accountId}`)
    return {
      chargesEnabled: account.charges_enabled as boolean,
      payoutsEnabled: account.payouts_enabled as boolean,
      detailsSubmitted: account.details_submitted as boolean,
    }
  }

  async createSetupIntent(params: {
    customerId: string
    metadata?: Record<string, string>
  }): Promise<{ setupIntentId: string; clientSecret: string }> {
    const body: Record<string, string> = {
      customer: params.customerId,
      usage: 'off_session',
    }
    if (params.metadata) {
      for (const [k, v] of Object.entries(params.metadata)) {
        body[`metadata[${k}]`] = v
      }
    }
    const result = await this.stripePost('/setup_intents', body)
    return {
      setupIntentId: result.id as string,
      clientSecret: result.client_secret as string,
    }
  }

  async attachPaymentMethod(params: {
    customerId: string
    paymentMethodId: string
  }): Promise<{ paymentMethodId: string }> {
    await this.stripePost(`/payment_methods/${params.paymentMethodId}/attach`, {
      customer: params.customerId,
    })
    return { paymentMethodId: params.paymentMethodId }
  }

  // ── Escrow lifecycle ────────────────────────────────────────────────────

  async captureEscrowFunds(params: {
    buyerAmountCents: number
    sellerCollateralCents: number
    escrowId: string
    buyerCustomerId: string
    buyerPaymentMethodId: string
    sellerCustomerId?: string
    sellerPaymentMethodId?: string
    metadata?: Record<string, string>
  }): Promise<{
    stripeBuyerPiId: string
    stripeSellerCollateralPiId: string | null
  }> {
    // 1. Create + confirm + capture buyer PI
    const buyerPi = await this.stripePost('/payment_intents', {
      amount: String(params.buyerAmountCents),
      currency: 'usd',
      customer: params.buyerCustomerId,
      payment_method: params.buyerPaymentMethodId,
      confirm: 'true',
      capture_method: 'manual',
      'metadata[escrow_id]': params.escrowId,
      'metadata[type]': 'escrow_buyer_payment',
    }, `escrow_${params.escrowId}_buyer`)

    const buyerPiId = buyerPi.id as string
    await this.stripePost(`/payment_intents/${buyerPiId}/capture`, {},
      `escrow_${params.escrowId}_buyer_capture`)

    // 2. Optional: seller collateral PI
    let sellerCollateralPiId: string | null = null
    if (params.sellerCollateralCents > 0 && params.sellerCustomerId && params.sellerPaymentMethodId) {
      try {
        const sellerPi = await this.stripePost('/payment_intents', {
          amount: String(params.sellerCollateralCents),
          currency: 'usd',
          customer: params.sellerCustomerId,
          payment_method: params.sellerPaymentMethodId,
          confirm: 'true',
          capture_method: 'manual',
          'metadata[escrow_id]': params.escrowId,
          'metadata[type]': 'escrow_seller_collateral',
        }, `escrow_${params.escrowId}_seller_collateral`)

        sellerCollateralPiId = sellerPi.id as string
        await this.stripePost(`/payment_intents/${sellerCollateralPiId}/capture`, {},
          `escrow_${params.escrowId}_seller_collateral_capture`)
      } catch (e) {
        // Atomic: if seller collateral fails, refund buyer PI
        await this.stripePost('/refunds', {
          payment_intent: buyerPiId,
          'metadata[type]': 'escrow_rollback',
          'metadata[escrow_id]': params.escrowId,
        }, `escrow_${params.escrowId}_buyer_rollback`)
        throw e
      }
    }

    return { stripeBuyerPiId: buyerPiId, stripeSellerCollateralPiId: sellerCollateralPiId }
  }

  async releaseFunds(params: {
    stripeBuyerPiId: string
    sellerConnectedAccountId: string
    sellerAmountCents: number
    stripeSellerCollateralPiId?: string
  }): Promise<{ transferId: string }> {
    // 1. Get charge ID from buyer PI
    const pi = await this.stripeGet(`/payment_intents/${params.stripeBuyerPiId}`)
    const chargeId = pi.latest_charge as string

    // 2. Transfer buyer payment to seller's connected account
    const transfer = await this.stripePost('/transfers', {
      amount: String(params.sellerAmountCents),
      currency: 'usd',
      destination: params.sellerConnectedAccountId,
      source_transaction: chargeId,
      'metadata[type]': 'escrow_release',
      'metadata[buyer_pi]': params.stripeBuyerPiId,
    })

    // 3. Refund seller collateral (return their deposit)
    if (params.stripeSellerCollateralPiId) {
      await this.stripePost('/refunds', {
        payment_intent: params.stripeSellerCollateralPiId,
        'metadata[type]': 'escrow_collateral_return',
      })
    }

    return { transferId: transfer.id as string }
  }

  async burnFunds(params: {
    stripeBuyerPiId: string
    stripeSellerCollateralPiId?: string
  }): Promise<void> {
    // Keep both on platform (no transfer, no refund) — platform revenue
    // Tag for audit trail
    await this.stripePost(`/payment_intents/${params.stripeBuyerPiId}`, {
      'metadata[burned]': 'true',
      'metadata[burned_at]': new Date().toISOString(),
    })
    if (params.stripeSellerCollateralPiId) {
      await this.stripePost(`/payment_intents/${params.stripeSellerCollateralPiId}`, {
        'metadata[burned]': 'true',
        'metadata[burned_at]': new Date().toISOString(),
      })
    }
  }

  async refundBuyerAndBurnCollateral(params: {
    stripeBuyerPiId: string
    buyerRefundCents: number
    stripeSellerCollateralPiId?: string
  }): Promise<void> {
    // 1. Refund buyer
    await this.stripePost('/refunds', {
      payment_intent: params.stripeBuyerPiId,
      amount: String(params.buyerRefundCents),
      'metadata[type]': 'escrow_timeout_refund',
    })

    // 2. Keep seller collateral (burn) — platform revenue
    if (params.stripeSellerCollateralPiId) {
      await this.stripePost(`/payment_intents/${params.stripeSellerCollateralPiId}`, {
        'metadata[burned]': 'true',
        'metadata[burned_at]': new Date().toISOString(),
      })
    }
  }
}
