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
    async captureEscrowFunds(params) {
      counter++
      calls.push({ method: 'captureEscrowFunds', params })
      return { stripeEscrowId: `pi_mock_${counter}` }
    },
    async releaseFunds(params) {
      calls.push({ method: 'releaseFunds', params })
    },
    async burnFunds(params) {
      calls.push({ method: 'burnFunds', params })
    },
    async refundBuyerAndBurnCollateral(params) {
      calls.push({ method: 'refundBuyerAndBurnCollateral', params })
    },
  }
}
