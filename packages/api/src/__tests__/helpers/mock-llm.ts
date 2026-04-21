/**
 * Mock LLMService for tests. Records all calls and returns configurable responses.
 * Same pattern as mock-ai.ts.
 */

import type { LLMCompletion, LLMService } from '../../lib/openrouter'

export interface LLMCall {
  model: string
  messages: Array<{ role: string; content: string }>
  maxTokens?: number
  temperature?: number
}

type MockResponse = string | LLMCompletion

function normalize(r: MockResponse): LLMCompletion {
  return typeof r === 'string' ? { content: r, costCents: 0 } : r
}

export function createMockLLM(): LLMService & {
  calls: LLMCall[]
  reset(): void
  setResponse(response: MockResponse): void
  setResponses(responses: MockResponse[]): void
  setError(error: Error): void
} {
  const calls: LLMCall[] = []
  let responses: MockResponse[] = ['{}']
  let callIndex = 0
  let nextError: Error | null = null

  return {
    calls,
    reset() {
      calls.length = 0
      callIndex = 0
      nextError = null
    },
    setResponse(response: MockResponse) {
      responses = [response]
      callIndex = 0
    },
    setResponses(r: MockResponse[]) {
      responses = r
      callIndex = 0
    },
    setError(error: Error) {
      nextError = error
    },
    async complete(params) {
      calls.push({
        model: params.model,
        messages: params.messages,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
      })

      if (nextError) {
        const err = nextError
        nextError = null
        throw err
      }

      const response = responses[callIndex % responses.length]
      callIndex++
      return normalize(response)
    },
  }
}
