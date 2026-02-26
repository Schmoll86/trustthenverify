/**
 * Mock ArbitrationService for tests. Configurable ruling.
 */

import type { ArbitrationService } from '../../lib/arbitration-service'
import type { ArbitrationEvidence, ArbitrationRuling } from '../../lib/arbitration-prompts'

export interface ArbitrationCall {
  evidence: ArbitrationEvidence
}

export function createMockArbitration(): ArbitrationService & {
  calls: ArbitrationCall[]
  reset(): void
  setRuling(ruling: ArbitrationRuling): void
  setError(error: Error): void
} {
  const calls: ArbitrationCall[] = []
  let nextRuling: ArbitrationRuling = {
    ruling: 'buyer_wins',
    rationale: 'Mock ruling',
    confidence: 0.9,
  }
  let nextError: Error | null = null

  return {
    calls,
    reset() {
      calls.length = 0
      nextError = null
    },
    setRuling(ruling: ArbitrationRuling) {
      nextRuling = ruling
    },
    setError(error: Error) {
      nextError = error
    },
    async arbitrate(evidence: ArbitrationEvidence): Promise<ArbitrationRuling> {
      calls.push({ evidence })
      if (nextError) {
        const err = nextError
        nextError = null
        throw err
      }
      return nextRuling
    },
  }
}
