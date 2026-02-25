/**
 * Tier 2 semantic constraint solver — async, requires Workers AI.
 * Builds on top of Tier 1 solver (solver.ts stays pure/sync).
 *
 * 3 Tier 2 types per SPEC-v2 §3.1.2:
 * - semantic_similarity: cosine similarity between target + reference embeddings
 * - topic_relevance: cosine similarity between deliverable text and reference topic
 * - coherence: LLM binary classification for logical coherence
 */

import { solveAll, type SolveAllResult } from './solver'
import { cosineSimilarity, type AIService } from './workers-ai'

export interface Tier2ConstraintResult {
  id: string
  passed: boolean
  score?: number
  error?: string
}

export interface SolveAllWithTier2Result extends SolveAllResult {
  tier2Used: boolean
}

interface Constraint {
  id: string
  type: string
  target: string
  params: Record<string, unknown>
}

interface FormalSpec {
  version: number
  constraints: Constraint[]
}

const TIER2_TYPES = new Set(['semantic_similarity', 'topic_relevance', 'coherence'])

export function isTier2(type: string): boolean {
  return TIER2_TYPES.has(type)
}

/**
 * Solve a single Tier 2 constraint using AI.
 */
export async function solveTier2Constraint(
  constraint: Constraint,
  deliverable: unknown,
  ai: AIService,
): Promise<Tier2ConstraintResult> {
  try {
    const { resolveTarget } = await import('./jsonpath')
    const values = resolveTarget(deliverable, constraint.target)
    if (values.length === 0) {
      return { id: constraint.id, passed: false, error: 'target resolved to empty' }
    }

    const targetText = values.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ')
    const minScore = (constraint.params.min_score as number) ?? 0.7

    switch (constraint.type) {
      case 'semantic_similarity': {
        const reference = constraint.params.reference_target as string
        if (!reference) return { id: constraint.id, passed: false, error: 'missing reference_target' }
        const embeddings = await ai.getEmbeddings([targetText, reference])
        const score = cosineSimilarity(embeddings[0], embeddings[1])
        return { id: constraint.id, passed: score >= minScore, score }
      }

      case 'topic_relevance': {
        const topic = constraint.params.reference_target as string
        if (!topic) return { id: constraint.id, passed: false, error: 'missing reference_target' }
        const embeddings = await ai.getEmbeddings([targetText, topic])
        const score = cosineSimilarity(embeddings[0], embeddings[1])
        return { id: constraint.id, passed: score >= minScore, score }
      }

      case 'coherence': {
        const prompt = `Evaluate if the following text is logically coherent. Answer with a score from 0.0 to 1.0 where 1.0 is perfectly coherent. Only respond with the numeric score.\n\nText: ${targetText}`
        const response = await ai.generateText(prompt)
        const score = parseFloat(response.trim())
        if (isNaN(score)) {
          return { id: constraint.id, passed: false, error: 'failed to parse coherence score' }
        }
        const clampedScore = Math.max(0, Math.min(1, score))
        return { id: constraint.id, passed: clampedScore >= minScore, score: clampedScore }
      }

      default:
        return { id: constraint.id, passed: false, error: `unknown tier2 type: ${constraint.type}` }
    }
  } catch (err) {
    return { id: constraint.id, passed: false, error: (err as Error).message }
  }
}

/**
 * Run Tier 1 solver first, then Tier 2 for semantic constraints.
 * If AI unavailable: skip Tier 2, return pass_partial if Tier 1 passed.
 */
export async function solveAllWithTier2(
  formalSpec: FormalSpec,
  deliverable: unknown,
  ai: AIService | null,
): Promise<SolveAllWithTier2Result> {
  // Split constraints into Tier 1 and Tier 2
  const tier1Constraints = formalSpec.constraints.filter(c => !isTier2(c.type))
  const tier2Constraints = formalSpec.constraints.filter(c => isTier2(c.type))

  // Run Tier 1
  const tier1Spec = { ...formalSpec, constraints: tier1Constraints }
  const tier1Result = solveAll(tier1Spec, deliverable)

  // No Tier 2 constraints → return Tier 1 result as-is
  if (tier2Constraints.length === 0) {
    return { ...tier1Result, tier2Used: false }
  }

  // Tier 1 failed → no point running Tier 2
  if (tier1Result.result === 'fail' || tier1Result.result === 'error') {
    return {
      result: tier1Result.result,
      constraintsTotal: formalSpec.constraints.length,
      constraintsPassed: tier1Result.constraintsPassed,
      failures: tier1Result.failures,
      tier2Used: false,
    }
  }

  // AI unavailable → Tier 2 skipped, partial pass
  if (!ai) {
    return {
      result: 'pass' as const,
      constraintsTotal: formalSpec.constraints.length,
      constraintsPassed: tier1Result.constraintsPassed,
      failures: tier2Constraints.map(c => ({ id: c.id, error: 'tier2 skipped: AI unavailable' })),
      tier2Used: false,
    }
  }

  // Run Tier 2
  let tier2Passed = 0
  const tier2Failures: Array<{ id: string; error: string }> = []

  for (const constraint of tier2Constraints) {
    const result = await solveTier2Constraint(constraint, deliverable, ai)
    if (result.passed) {
      tier2Passed++
    } else {
      tier2Failures.push({ id: result.id, error: result.error ?? 'constraint failed' })
    }
  }

  const totalPassed = tier1Result.constraintsPassed + tier2Passed
  const totalConstraints = formalSpec.constraints.length
  const allFailures = [...tier1Result.failures, ...tier2Failures]

  return {
    result: totalPassed === totalConstraints ? 'pass' : 'fail',
    constraintsTotal: totalConstraints,
    constraintsPassed: totalPassed,
    failures: allFailures,
    tier2Used: true,
  }
}
