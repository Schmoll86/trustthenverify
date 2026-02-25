/**
 * Mock NostrService for tests. Records publish calls, configurable success/failure.
 */

import type { NostrService, NostrEvent } from '../../lib/nostr'

export interface NostrPublishCall {
  event: NostrEvent
}

export function createMockNostr(): NostrService & {
  calls: NostrPublishCall[]
  reset(): void
  setShouldFail(fail: boolean): void
} {
  const calls: NostrPublishCall[] = []
  let shouldFail = false

  return {
    calls,
    reset() {
      calls.length = 0
      shouldFail = false
    },
    setShouldFail(fail: boolean) {
      shouldFail = fail
    },
    async publish(event: NostrEvent) {
      calls.push({ event })
      return shouldFail ? null : event.id
    },
  }
}
