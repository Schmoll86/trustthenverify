/**
 * Mock Queue for tests. Captures send() calls for assertion.
 */

export interface QueueMessage {
  body: unknown
}

export function createMockQueue(): {
  send(message: unknown): Promise<void>
  messages: QueueMessage[]
  reset(): void
} {
  const messages: QueueMessage[] = []

  return {
    messages,
    async send(message: unknown) {
      messages.push({ body: message })
    },
    reset() {
      messages.length = 0
    },
  }
}
