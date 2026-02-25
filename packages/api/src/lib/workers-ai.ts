/**
 * Workers AI typed abstraction — minimal wrapper over Env.AI binding.
 * Interface-based for testability.
 */

import type { WorkersAI } from './db'

export interface AIService {
  getEmbeddings(texts: string[]): Promise<number[][]>
  generateText(prompt: string): Promise<string>
}

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5'
const TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct'

export class RealAIService implements AIService {
  private ai: WorkersAI

  constructor(ai: WorkersAI) {
    this.ai = ai
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    const result = await this.ai.run(EMBEDDING_MODEL, { text: texts }) as {
      data: number[][]
    }
    return result.data
  }

  async generateText(prompt: string): Promise<string> {
    const result = await this.ai.run(TEXT_MODEL, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2048,
    }) as { response: string }
    return result.response
  }
}

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
