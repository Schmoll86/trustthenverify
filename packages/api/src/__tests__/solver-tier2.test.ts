import { describe, it, expect } from 'vitest'
import { solveTier2Constraint, solveAllWithTier2, isTier2 } from '../lib/solver-tier2'
import { createMockAI } from './helpers/mock-ai'

describe('isTier2', () => {
  it('identifies Tier 2 types', () => {
    expect(isTier2('semantic_similarity')).toBe(true)
    expect(isTier2('topic_relevance')).toBe(true)
    expect(isTier2('coherence')).toBe(true)
  })

  it('rejects Tier 1 types', () => {
    expect(isTier2('exists')).toBe(false)
    expect(isTier2('range')).toBe(false)
    expect(isTier2('regex')).toBe(false)
  })
})

describe('solveTier2Constraint', () => {
  it('semantic_similarity: passes when cosine >= min_score', async () => {
    const ai = createMockAI()
    // Identical vectors → cosine = 1.0
    ai.setEmbeddings([[1, 0, 0], [1, 0, 0]])

    const result = await solveTier2Constraint(
      { id: 'c1', type: 'semantic_similarity', target: '$.text', params: { reference_target: 'hello world', min_score: 0.8 } },
      { text: 'hello world' },
      ai,
    )

    expect(result.passed).toBe(true)
    expect(result.score).toBeCloseTo(1.0)
  })

  it('semantic_similarity: fails when cosine < min_score', async () => {
    const ai = createMockAI()
    // Orthogonal vectors → cosine = 0
    ai.setEmbeddings([[1, 0, 0], [0, 1, 0]])

    const result = await solveTier2Constraint(
      { id: 'c1', type: 'semantic_similarity', target: '$.text', params: { reference_target: 'something else', min_score: 0.5 } },
      { text: 'hello' },
      ai,
    )

    expect(result.passed).toBe(false)
    expect(result.score).toBeCloseTo(0)
  })

  it('semantic_similarity: fails when missing reference_target', async () => {
    const ai = createMockAI()

    const result = await solveTier2Constraint(
      { id: 'c1', type: 'semantic_similarity', target: '$.text', params: { min_score: 0.5 } },
      { text: 'hello' },
      ai,
    )

    expect(result.passed).toBe(false)
    expect(result.error).toContain('missing reference_target')
  })

  it('topic_relevance: passes with similar embeddings', async () => {
    const ai = createMockAI()
    ai.setEmbeddings([[0.9, 0.1, 0], [0.85, 0.15, 0]])

    const result = await solveTier2Constraint(
      { id: 'c1', type: 'topic_relevance', target: '$.content', params: { reference_target: 'machine learning', min_score: 0.5 } },
      { content: 'deep learning neural networks' },
      ai,
    )

    expect(result.passed).toBe(true)
  })

  it('coherence: passes when LLM returns high score', async () => {
    const ai = createMockAI()
    ai.setTextResponse('0.95')

    const result = await solveTier2Constraint(
      { id: 'c1', type: 'coherence', target: '$.text', params: { min_score: 0.7 } },
      { text: 'The cat sat on the mat. It was comfortable.' },
      ai,
    )

    expect(result.passed).toBe(true)
    expect(result.score).toBeCloseTo(0.95)
  })

  it('coherence: fails when LLM returns low score', async () => {
    const ai = createMockAI()
    ai.setTextResponse('0.3')

    const result = await solveTier2Constraint(
      { id: 'c1', type: 'coherence', target: '$.text', params: { min_score: 0.7 } },
      { text: 'Purple monkey dishwasher. The economy is.' },
      ai,
    )

    expect(result.passed).toBe(false)
    expect(result.score).toBeCloseTo(0.3)
  })

  it('coherence: handles non-numeric LLM response', async () => {
    const ai = createMockAI()
    ai.setTextResponse('The text seems mostly coherent.')

    const result = await solveTier2Constraint(
      { id: 'c1', type: 'coherence', target: '$.text', params: { min_score: 0.7 } },
      { text: 'test' },
      ai,
    )

    expect(result.passed).toBe(false)
    expect(result.error).toContain('failed to parse')
  })

  it('fails when target resolves to empty', async () => {
    const ai = createMockAI()

    const result = await solveTier2Constraint(
      { id: 'c1', type: 'semantic_similarity', target: '$.missing', params: { reference_target: 'x', min_score: 0.5 } },
      { text: 'hello' },
      ai,
    )

    expect(result.passed).toBe(false)
    expect(result.error).toContain('target resolved to empty')
  })

  it('uses default min_score of 0.7', async () => {
    const ai = createMockAI()
    // Cosine of these = ~0.707 (just barely passes 0.7)
    ai.setEmbeddings([[1, 1, 0], [1, 0, 0]])

    const result = await solveTier2Constraint(
      { id: 'c1', type: 'semantic_similarity', target: '$.text', params: { reference_target: 'test' } },
      { text: 'hello' },
      ai,
    )

    // cos(45°) ≈ 0.707
    expect(result.score).toBeCloseTo(0.707, 2)
    expect(result.passed).toBe(true)
  })
})

describe('solveAllWithTier2', () => {
  it('returns Tier 1 result when no Tier 2 constraints', async () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'exists', target: '$.name', params: {} },
      ],
    }

    const result = await solveAllWithTier2(spec, { name: 'hello' }, null)

    expect(result.result).toBe('pass')
    expect(result.tier2Used).toBe(false)
    expect(result.constraintsPassed).toBe(1)
  })

  it('skips Tier 2 when AI unavailable', async () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'exists', target: '$.name', params: {} },
        { id: 'c2', type: 'semantic_similarity', target: '$.name', params: { reference_target: 'test', min_score: 0.5 } },
      ],
    }

    const result = await solveAllWithTier2(spec, { name: 'hello' }, null)

    expect(result.result).toBe('pass')
    expect(result.tier2Used).toBe(false)
    expect(result.constraintsTotal).toBe(2)
    expect(result.constraintsPassed).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].error).toContain('AI unavailable')
  })

  it('runs Tier 2 when AI available', async () => {
    const ai = createMockAI()
    ai.setEmbeddings([[1, 0], [1, 0]])

    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'exists', target: '$.name', params: {} },
        { id: 'c2', type: 'semantic_similarity', target: '$.name', params: { reference_target: 'greeting', min_score: 0.5 } },
      ],
    }

    const result = await solveAllWithTier2(spec, { name: 'hello' }, ai)

    expect(result.result).toBe('pass')
    expect(result.tier2Used).toBe(true)
    expect(result.constraintsPassed).toBe(2)
  })

  it('does not run Tier 2 when Tier 1 fails', async () => {
    const ai = createMockAI()

    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'exists', target: '$.missing', params: {} },
        { id: 'c2', type: 'semantic_similarity', target: '$.name', params: { reference_target: 'test', min_score: 0.5 } },
      ],
    }

    const result = await solveAllWithTier2(spec, { name: 'hello' }, ai)

    expect(result.result).toBe('fail')
    expect(result.tier2Used).toBe(false)
    expect(ai.calls).toHaveLength(0) // AI never called
  })

  it('mixed Tier 1 + Tier 2 with Tier 2 failure', async () => {
    const ai = createMockAI()
    // Orthogonal → cosine = 0, fails min_score
    ai.setEmbeddings([[1, 0], [0, 1]])

    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'exists', target: '$.name', params: {} },
        { id: 'c2', type: 'semantic_similarity', target: '$.name', params: { reference_target: 'something', min_score: 0.8 } },
      ],
    }

    const result = await solveAllWithTier2(spec, { name: 'hello' }, ai)

    expect(result.result).toBe('fail')
    expect(result.tier2Used).toBe(true)
    expect(result.constraintsPassed).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].id).toBe('c2')
  })
})
