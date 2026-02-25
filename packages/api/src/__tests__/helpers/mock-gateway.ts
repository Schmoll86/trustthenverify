/**
 * Mock GatewayService for tests. Records all calls and returns configurable results.
 */

import type { GatewayService, GatewayVerificationResult } from '../../lib/gateway'

export interface GatewayCall {
  params: Record<string, unknown>
}

export function createMockGateway(): GatewayService & {
  calls: GatewayCall[]
  reset(): void
  setResult(result: GatewayVerificationResult): void
} {
  const calls: GatewayCall[] = []
  let nextResult: GatewayVerificationResult = {
    result: 'pass',
    constraintsTotal: 0,
    constraintsPassed: 0,
    failures: [],
    gatewaySignature: 'mock_sig',
    verifiedAt: new Date().toISOString(),
  }

  return {
    calls,
    reset() {
      calls.length = 0
    },
    setResult(result: GatewayVerificationResult) {
      nextResult = result
    },
    async verify(params) {
      calls.push({ params: params as unknown as Record<string, unknown> })
      return nextResult
    },
  }
}
