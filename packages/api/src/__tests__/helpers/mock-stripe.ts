/**
 * Mock StripeService for tests. Records all calls for assertion.
 */

import type { StripeService } from '../../lib/stripe'

export interface StripeCall {
  method: string
  params: Record<string, unknown>
}

export function createMockStripe(): StripeService & { calls: StripeCall[]; reset(): void } {
  const calls: StripeCall[] = []
  let counter = 0

  return {
    calls,
    reset() {
      calls.length = 0
      counter = 0
    },

    // Onboarding
    async createCustomer(params) {
      counter++
      calls.push({ method: 'createCustomer', params })
      return { customerId: `cus_mock_${counter}` }
    },
    async createConnectAccount(params) {
      counter++
      calls.push({ method: 'createConnectAccount', params })
      return {
        accountId: `acct_mock_${counter}`,
        onboardingUrl: `https://connect.stripe.com/setup/mock_${counter}`,
      }
    },
    async getAccountStatus(accountId) {
      calls.push({ method: 'getAccountStatus', params: { accountId } })
      return { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true }
    },
    async createSetupIntent(params) {
      counter++
      calls.push({ method: 'createSetupIntent', params })
      return {
        setupIntentId: `seti_mock_${counter}`,
        clientSecret: `seti_mock_${counter}_secret_test`,
      }
    },
    async attachPaymentMethod(params) {
      calls.push({ method: 'attachPaymentMethod', params })
      return { paymentMethodId: params.paymentMethodId }
    },

    // Escrow lifecycle
    async captureEscrowFunds(params) {
      counter++
      calls.push({ method: 'captureEscrowFunds', params })
      return {
        stripeBuyerPiId: `pi_buyer_mock_${counter}`,
        stripeSellerCollateralPiId: params.sellerCollateralCents > 0 && params.sellerCustomerId
          ? `pi_collateral_mock_${counter}`
          : null,
      }
    },
    async releaseFunds(params) {
      counter++
      calls.push({ method: 'releaseFunds', params })
      return { transferId: `tr_mock_${counter}` }
    },
    async burnFunds(params) {
      calls.push({ method: 'burnFunds', params })
    },
    async transferToConnectedAccount(params) {
      counter++
      calls.push({ method: 'transferToConnectedAccount', params })
      return { transferId: `tr_oracle_mock_${counter}` }
    },
    async refundBuyerAndBurnCollateral(params) {
      calls.push({ method: 'refundBuyerAndBurnCollateral', params })
    },
  }
}
