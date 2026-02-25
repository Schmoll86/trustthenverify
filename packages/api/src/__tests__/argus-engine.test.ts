import { describe, it, expect } from 'vitest'
import { runArgusBatch, computeCoverage, shouldAutoApprove, type RefinementState } from '../lib/argus-engine'
import { createMockAI } from './helpers/mock-ai'

function makeState(overrides: Partial<RefinementState> = {}): RefinementState {
  return {
    workingSpec: { version: 1, constraints: [{ id: 'c1', type: 'exists', target: '$.name', params: {} }] },
    currentRound: 0,
    lastExploitRound: 0,
    consecutiveClean: 0,
    exploits: [],
    tier2Introduced: false,
    budget: 1000,
    ...overrides,
  }
}

describe('runArgusBatch', () => {
  it('processes up to 10 rounds per batch', async () => {
    const ai = createMockAI()
    // All rounds return "no exploit found"
    ai.setTextResponse(JSON.stringify({ exploit: null, explanation: 'No exploit found' }))

    const state = makeState()
    const result = await runArgusBatch('test intent', state, ai)

    expect(result.state.currentRound).toBe(10)
    expect(result.state.consecutiveClean).toBe(10)
    expect(result.done).toBe(false)
    expect(ai.calls).toHaveLength(10) // 10 adversary calls, 0 refinement
  })

  it('increments consecutiveClean on no exploit', async () => {
    const ai = createMockAI()
    ai.setTextResponse(JSON.stringify({ exploit: null, explanation: 'No exploit' }))

    const state = makeState({ budget: 5 })
    const result = await runArgusBatch('test', state, ai)

    expect(result.state.consecutiveClean).toBe(5)
    expect(result.state.exploits).toHaveLength(0)
    expect(result.done).toBe(true) // budget exhausted
  })

  it('records exploit and attempts refinement', async () => {
    const ai = createMockAI()
    const noExploit = JSON.stringify({ exploit: null, explanation: 'No exploit' })
    // Round 1: adversary finds exploit, then refinement patches
    // Rounds 2-5: no more exploits (need enough entries to avoid cycling)
    ai.setTextResponses([
      JSON.stringify({ exploit: { name: 'bad' }, explanation: 'name is too short' }),
      JSON.stringify({
        formal_spec: { version: 1, constraints: [
          { id: 'c1', type: 'exists', target: '$.name', params: {} },
          { id: 'c2', type: 'length', target: '$.name', params: { min: 5 } },
        ] },
        tier2_introduced: false,
      }),
      noExploit, noExploit, noExploit, noExploit,
    ])

    const state = makeState({ budget: 5 })
    const result = await runArgusBatch('name must be meaningful', state, ai)

    expect(result.state.exploits).toHaveLength(1)
    expect(result.state.exploits[0].round).toBe(1)
    expect(result.state.lastExploitRound).toBe(1)
    expect(result.state.consecutiveClean).toBe(4) // rounds 2-5
    // Working spec should have been updated with the new constraint
    const constraints = (result.state.workingSpec as { constraints: unknown[] }).constraints
    expect(constraints).toHaveLength(2)
  })

  it('handles invalid refinement response gracefully', async () => {
    const ai = createMockAI()
    const noExploit = JSON.stringify({ exploit: null, explanation: 'No exploit' })
    ai.setTextResponses([
      // Round 1: adversary finds exploit
      JSON.stringify({ exploit: { x: 1 }, explanation: 'test' }),
      // Round 1: refinement returns garbage
      'I cannot refine this spec',
      // Rounds 2-3: no more exploits
      noExploit, noExploit,
    ])

    const state = makeState({ budget: 3 })
    const result = await runArgusBatch('test', state, ai)

    // Exploit recorded but spec unchanged (refinement parse failed)
    expect(result.state.exploits).toHaveLength(1)
    const constraints = (result.state.workingSpec as { constraints: unknown[] }).constraints
    expect(constraints).toHaveLength(1) // original spec unchanged
  })

  it('detects Tier 2 introduction', async () => {
    const ai = createMockAI()
    ai.setTextResponses([
      JSON.stringify({ exploit: { text: 'irrelevant' }, explanation: 'off topic' }),
      JSON.stringify({
        formal_spec: { version: 1, constraints: [
          { id: 'c1', type: 'exists', target: '$.text', params: {} },
          { id: 'c2', type: 'semantic_similarity', target: '$.text', params: { reference_target: 'topic', min_score: 0.7 } },
        ] },
        tier2_introduced: true,
      }),
      JSON.stringify({ exploit: null, explanation: 'No exploit' }),
    ])

    const state = makeState({ budget: 3 })
    const result = await runArgusBatch('text must be on topic', state, ai)

    expect(result.state.tier2Introduced).toBe(true)
  })

  it('stops at budget limit', async () => {
    const ai = createMockAI()
    ai.setTextResponse(JSON.stringify({ exploit: null, explanation: 'No exploit' }))

    const state = makeState({ budget: 15, currentRound: 8 })
    const result = await runArgusBatch('test', state, ai)

    expect(result.state.currentRound).toBe(15)
    expect(result.done).toBe(true)
  })

  it('early stops after 200 consecutive clean rounds', async () => {
    const ai = createMockAI()
    ai.setTextResponse(JSON.stringify({ exploit: null, explanation: 'No exploit' }))

    const state = makeState({ budget: 5000, consecutiveClean: 195 })
    const result = await runArgusBatch('test', state, ai)

    // Should stop when consecutiveClean hits 200 (195 + 5 rounds)
    expect(result.state.consecutiveClean).toBe(200)
    expect(result.done).toBe(true)
    expect(result.state.currentRound).toBe(5)
  })

  it('handles AI error gracefully (treats as clean round)', async () => {
    const ai = createMockAI()
    // Override to throw
    ai.generateText = async () => { throw new Error('AI down') }

    const state = makeState({ budget: 3 })
    const result = await runArgusBatch('test', state, ai)

    expect(result.state.currentRound).toBe(3)
    expect(result.state.consecutiveClean).toBe(3)
    expect(result.state.exploits).toHaveLength(0)
    expect(result.done).toBe(true)
  })

  it('returns done=true immediately when budget already met', async () => {
    const ai = createMockAI()
    const state = makeState({ budget: 10, currentRound: 10 })
    const result = await runArgusBatch('test', state, ai)

    expect(result.done).toBe(true)
    expect(result.state.currentRound).toBe(10) // no new rounds
  })
})

describe('computeCoverage', () => {
  it('returns 1 when no exploits found', () => {
    expect(computeCoverage(100, 0)).toBe(1)
  })

  it('returns 0 when last exploit is on the last round', () => {
    expect(computeCoverage(100, 100)).toBe(0)
  })

  it('computes ratio correctly', () => {
    // 100 rounds, last exploit at 20 → 80 clean out of 100
    expect(computeCoverage(100, 20)).toBe(0.8)
  })

  it('returns 0 for 0 total rounds', () => {
    expect(computeCoverage(0, 0)).toBe(0)
  })

  it('high coverage example', () => {
    // 1000 rounds, last exploit at round 50
    expect(computeCoverage(1000, 50)).toBe(0.95)
  })
})

describe('shouldAutoApprove', () => {
  it('approves with high coverage and no Tier 2', () => {
    expect(shouldAutoApprove(0.95, false)).toBe(true)
  })

  it('approves at exact 0.9 threshold', () => {
    expect(shouldAutoApprove(0.9, false)).toBe(true)
  })

  it('rejects below 0.9', () => {
    expect(shouldAutoApprove(0.89, false)).toBe(false)
  })

  it('rejects when Tier 2 used', () => {
    expect(shouldAutoApprove(0.95, true)).toBe(false)
  })

  it('rejects low coverage with Tier 2', () => {
    expect(shouldAutoApprove(0.5, true)).toBe(false)
  })
})
