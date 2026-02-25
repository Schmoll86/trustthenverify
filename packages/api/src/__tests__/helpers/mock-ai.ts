/**
 * Mock AIService for tests. Records all calls and returns configurable responses.
 */

import type { AIService } from '../../lib/workers-ai'

export interface AICall {
  method: 'getEmbeddings' | 'generateText'
  args: unknown[]
}

export function createMockAI(): AIService & {
  calls: AICall[]
  reset(): void
  setEmbeddings(embeddings: number[][]): void
  setTextResponse(response: string): void
  setTextResponses(responses: string[]): void
} {
  const calls: AICall[] = []
  let nextEmbeddings: number[][] = [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5]]
  let textResponses: string[] = ['{}']
  let textCallIndex = 0

  return {
    calls,
    reset() {
      calls.length = 0
      textCallIndex = 0
    },
    setEmbeddings(embeddings: number[][]) {
      nextEmbeddings = embeddings
    },
    setTextResponse(response: string) {
      textResponses = [response]
      textCallIndex = 0
    },
    setTextResponses(responses: string[]) {
      textResponses = responses
      textCallIndex = 0
    },
    async getEmbeddings(texts: string[]): Promise<number[][]> {
      calls.push({ method: 'getEmbeddings', args: [texts] })
      return nextEmbeddings.slice(0, texts.length)
    },
    async generateText(prompt: string): Promise<string> {
      calls.push({ method: 'generateText', args: [prompt] })
      const response = textResponses[textCallIndex % textResponses.length]
      textCallIndex++
      return response
    },
  }
}
