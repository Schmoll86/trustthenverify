/**
 * Argus Codex engine — core adversarial refinement loop.
 * Pure function with injected dependencies for testability.
 * Per SPEC-v2 §11 items 25-30.
 */

import { validateFormalSpec } from './validate-formal-spec'
import {
  adversaryPrompt,
  refinementPrompt,
  parseAdversaryResponse,
  parseRefinementResponse,
} from './argus-prompts'
import type { AIService } from './workers-ai'

export interface RefinementState {
  workingSpec: Record<string, unknown>
  currentRound: number
  lastExploitRound: number
  consecutiveClean: number
  exploits: Array<{ round: number; exploit: Record<string, unknown>; explanation: string }>
  tier2Introduced: boolean
  budget: number
}

export interface BatchResult {
  state: RefinementState
  done: boolean
  error?: string
}

const ROUNDS_PER_BATCH = 10
const EARLY_STOP_CLEAN = 200

/**
 * Process one batch of refinement rounds (up to 10).
 */
export async function runArgusBatch(
  intent: string,
  state: RefinementState,
  ai: AIService,
): Promise<BatchResult> {
  const s = { ...state, exploits: [...state.exploits] }
  const roundsThisBatch = Math.min(ROUNDS_PER_BATCH, s.budget - s.currentRound)

  if (roundsThisBatch <= 0) {
    return { state: s, done: true }
  }

  for (let i = 0; i < roundsThisBatch; i++) {
    s.currentRound++

    try {
      // Step 1: Adversary generates exploit
      const advPrompt = adversaryPrompt(intent, s.workingSpec)
      const advResponse = await ai.generateText(advPrompt)
      const parsed = parseAdversaryResponse(advResponse)

      if (!parsed) {
        // No valid exploit → clean round
        s.consecutiveClean++
      } else {
        // Exploit found → attempt refinement
        s.lastExploitRound = s.currentRound
        s.consecutiveClean = 0
        s.exploits.push({
          round: s.currentRound,
          exploit: parsed.exploit,
          explanation: parsed.explanation,
        })

        // Step 2: Refine spec to block exploit
        const refPrompt = refinementPrompt(
          intent, s.workingSpec, parsed.exploit, parsed.explanation,
        )
        const refResponse = await ai.generateText(refPrompt)
        const refined = parseRefinementResponse(refResponse)

        if (refined) {
          // Validate the patched spec
          const validation = validateFormalSpec(refined.formalSpec)
          if (validation.valid) {
            s.workingSpec = refined.formalSpec

            // Check if Tier 2 was introduced
            const constraints = (refined.formalSpec as { constraints: Array<{ type: string }> }).constraints
            const hasTier2 = constraints.some(c =>
              c.type === 'semantic_similarity' || c.type === 'topic_relevance' || c.type === 'coherence'
            )
            if (hasTier2) {
              s.tier2Introduced = true
            }
          }
          // Invalid patched spec → skip, treat as if refinement failed (round still counts)
        }
      }
    } catch {
      // AI error on this round → treat as clean (conservative)
      s.consecutiveClean++
    }

    // Check early stop
    if (s.consecutiveClean >= EARLY_STOP_CLEAN) {
      return { state: s, done: true }
    }

    // Budget exhausted
    if (s.currentRound >= s.budget) {
      return { state: s, done: true }
    }
  }

  return { state: s, done: false }
}

/**
 * Compute coverage estimate: proportion of rounds since last exploit that were clean.
 */
export function computeCoverage(totalRounds: number, lastExploitRound: number): number {
  if (totalRounds === 0) return 0
  if (lastExploitRound === 0) return 1  // No exploits ever found
  const roundsAfterLastExploit = totalRounds - lastExploitRound
  if (roundsAfterLastExploit <= 0) return 0
  return roundsAfterLastExploit / totalRounds
}

/**
 * Determine if policy should auto-approve (coverage >= 0.9, Tier 1 only).
 */
export function shouldAutoApprove(coverage: number, tier2Used: boolean): boolean {
  return coverage >= 0.9 && !tier2Used
}
