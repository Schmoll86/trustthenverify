/**
 * Mock OnchainService for tests. Records all calls for assertion.
 * Follows createMockStripe() pattern.
 */

import type { OnchainService } from '../../lib/onchain'

export interface OnchainCall {
  method: string
  params: Record<string, unknown>
}

export function createMockOnchain(options?: {
  fundingState?: 'created' | 'buyer_funded' | 'active'
}): OnchainService & { calls: OnchainCall[]; reset(): void } {
  const calls: OnchainCall[] = []
  let counter = 0
  const fundingState = options?.fundingState ?? 'active'

  return {
    calls,
    reset() {
      calls.length = 0
      counter = 0
    },

    async deployEscrow(params) {
      counter++
      calls.push({ method: 'deployEscrow', params })
      return {
        contractAddress: `0x${counter.toString(16).padStart(40, '0')}`,
        txHash: `0x${'ab'.repeat(32)}`,
      }
    },

    async checkFunding(contractAddress) {
      calls.push({ method: 'checkFunding', params: { contractAddress } })
      return {
        state: fundingState,
        buyerFunded: fundingState === 'buyer_funded' || fundingState === 'active',
        sellerFunded: fundingState === 'active',
      }
    },

    async gatewayRelease(params) {
      calls.push({ method: 'gatewayRelease', params })
      return { txHash: `0x${'cd'.repeat(32)}` }
    },

    async gatewayFail(params) {
      calls.push({ method: 'gatewayFail', params })
      return { txHash: `0x${'ef'.repeat(32)}` }
    },

    async triggerTimeout(contractAddress) {
      calls.push({ method: 'triggerTimeout', params: { contractAddress } })
      return { txHash: `0x${'01'.repeat(32)}` }
    },

    async getContractState(contractAddress) {
      calls.push({ method: 'getContractState', params: { contractAddress } })
      return fundingState
    },
  }
}
