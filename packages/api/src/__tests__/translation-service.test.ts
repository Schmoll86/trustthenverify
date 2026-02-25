import { describe, it, expect } from 'vitest'
import { translatePolicy } from '../lib/translation-service'
import { createMockLLM } from './helpers/mock-llm'

const validTranslatorResponse = JSON.stringify({
  formal_spec: {
    version: 1,
    constraints: [
      { id: 'c1', type: 'exists', target: '$.results', params: {}, clauseRef: '0' },
      { id: 'c2', type: 'count', target: '$.results', params: { min: 3 }, clauseRef: '0' },
      { id: 'c3', type: 'format', target: '$.results[*].url', params: { format: 'uri' }, clauseRef: '1' },
    ],
  },
  clauses: [
    { index: 0, text: 'Return at least 3 results', constraint_ids: ['c1', 'c2'], status: 'covered' },
    { index: 1, text: 'Each result has a valid URL', constraint_ids: ['c3'], status: 'covered' },
  ],
  uncovered_clauses: [],
  attack_surfaces: ['Empty results'],
})

const validCrossValidationPass = JSON.stringify({
  contradictions: [],
  uncovered_clauses: [],
  exploit: null,
  verdict: 'pass',
})

const validCrossValidationFail = JSON.stringify({
  contradictions: ['c1 does not enforce non-empty'],
  uncovered_clauses: [],
  exploit: { example: { results: [] }, explanation: 'Empty array passes exists' },
  verdict: 'fail',
})

describe('translatePolicy', () => {
  it('happy path: translator succeeds + cross-validator passes → validated', async () => {
    const llm = createMockLLM()
    llm.setResponses([validTranslatorResponse, validCrossValidationPass])

    const result = await translatePolicy({
      intent: 'Return at least 3 results with valid URLs',
      llm,
      translatorModel: 'test-translator',
      crossValidatorModel: 'test-validator',
    })

    expect(result.status).toBe('validated')
    expect(result.formalSpec).toHaveProperty('version', 1)
    expect(result.clauses).toHaveLength(2)
    expect(result.translationModel).toBe('test-translator')
    expect(result.crossValidatorModel).toBe('test-validator')
    expect(result.crossValidation).not.toBeNull()
    expect(result.crossValidation!.verdict).toBe('pass')
    expect(result.tier2Used).toBe(false)

    // Two calls: translator + cross-validator
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[0].model).toBe('test-translator')
    expect(llm.calls[1].model).toBe('test-validator')
  })

  it('retries on garbage translator response then succeeds', async () => {
    const llm = createMockLLM()
    llm.setResponses(['not json at all', validTranslatorResponse, validCrossValidationPass])

    const result = await translatePolicy({
      intent: 'test',
      llm,
      translatorModel: 'test-translator',
      crossValidatorModel: 'test-validator',
    })

    expect(result.status).toBe('validated')
    // 1st attempt (garbage) + 2nd attempt (success) + cross-validation
    expect(llm.calls).toHaveLength(3)
  })

  it('retries on invalid formal_spec then succeeds', async () => {
    const invalidSpec = JSON.stringify({
      formal_spec: { version: 2, constraints: [] },
      clauses: [],
    })
    const llm = createMockLLM()
    llm.setResponses([invalidSpec, validTranslatorResponse, validCrossValidationPass])

    const result = await translatePolicy({
      intent: 'test',
      llm,
      translatorModel: 'test-translator',
      crossValidatorModel: 'test-validator',
    })

    // Invalid spec (version 2) fails parse → retry → success
    expect(result.status).toBe('validated')
  })

  it('max retries exhausted → draft with errors', async () => {
    const llm = createMockLLM()
    llm.setResponses(['garbage1', 'garbage2', 'garbage3'])

    const result = await translatePolicy({
      intent: 'test',
      llm,
      translatorModel: 'test-translator',
      crossValidatorModel: 'test-validator',
    })

    expect(result.status).toBe('draft')
    expect(result.errors).toBeDefined()
    expect(result.errors!.length).toBe(3)
    expect(result.formalSpec).toEqual({ version: 1, constraints: [] })
  })

  it('LLM throws error → retries then draft', async () => {
    const llm = createMockLLM()
    // All 3 attempts will throw
    llm.setResponses(['will not be used'])
    let callCount = 0
    const originalComplete = llm.complete.bind(llm)
    llm.complete = async (params) => {
      callCount++
      if (callCount <= 3) throw new Error('OpenRouter 503: Service Unavailable')
      return originalComplete(params)
    }

    const result = await translatePolicy({
      intent: 'test',
      llm,
      translatorModel: 'test-translator',
      crossValidatorModel: 'test-validator',
    })

    expect(result.status).toBe('draft')
    expect(result.errors!.some(e => e.includes('503'))).toBe(true)
  })

  it('cross-validator fails verdict → draft', async () => {
    const llm = createMockLLM()
    llm.setResponses([validTranslatorResponse, validCrossValidationFail])

    const result = await translatePolicy({
      intent: 'test',
      llm,
      translatorModel: 'test-translator',
      crossValidatorModel: 'test-validator',
    })

    expect(result.status).toBe('draft')
    expect(result.crossValidation).not.toBeNull()
    expect(result.crossValidation!.verdict).toBe('fail')
    // formalSpec should still be populated (translation succeeded)
    expect((result.formalSpec as { constraints: unknown[] }).constraints.length).toBeGreaterThan(0)
  })

  it('cross-validator returns garbage → validated anyway', async () => {
    const llm = createMockLLM()
    // Translator succeeds, cross-validator returns garbage twice (1 retry)
    llm.setResponses([validTranslatorResponse, 'garbage', 'garbage'])

    const result = await translatePolicy({
      intent: 'test',
      llm,
      translatorModel: 'test-translator',
      crossValidatorModel: 'test-validator',
    })

    // Translation succeeded, cross-validation non-fatal → validated
    expect(result.status).toBe('validated')
    expect(result.crossValidation).toBeNull()
  })

  it('uncovered clauses → draft', async () => {
    const withUncovered = JSON.stringify({
      formal_spec: {
        version: 1,
        constraints: [{ id: 'c1', type: 'exists', target: '$.results', params: {} }],
      },
      clauses: [
        { index: 0, text: 'Return results', constraint_ids: ['c1'], status: 'covered' },
        { index: 1, text: 'Results must be recent', constraint_ids: [], status: 'uncovered' },
      ],
      uncovered_clauses: [1],
      attack_surfaces: [],
    })

    const llm = createMockLLM()
    llm.setResponses([withUncovered, validCrossValidationPass])

    const result = await translatePolicy({
      intent: 'test',
      llm,
      translatorModel: 'test-translator',
      crossValidatorModel: 'test-validator',
    })

    expect(result.status).toBe('draft')
    expect(result.clauses.some(c => c.status === 'uncovered')).toBe(true)
  })

  it('detects tier2 usage', async () => {
    const tier2Response = JSON.stringify({
      formal_spec: {
        version: 1,
        constraints: [
          { id: 'c1', type: 'exists', target: '$.results', params: {} },
          { id: 'c2', type: 'semantic_similarity', target: '$.summary', params: { min_score: 0.8, reference_target: '$.query' } },
        ],
      },
      clauses: [
        { index: 0, text: 'Return results', constraint_ids: ['c1', 'c2'], status: 'covered' },
      ],
      uncovered_clauses: [],
      attack_surfaces: [],
    })

    const llm = createMockLLM()
    llm.setResponses([tier2Response, validCrossValidationPass])

    const result = await translatePolicy({
      intent: 'test',
      llm,
      translatorModel: 'test-translator',
      crossValidatorModel: 'test-validator',
    })

    expect(result.tier2Used).toBe(true)
  })

  it('passes clauses through to translator', async () => {
    const llm = createMockLLM()
    llm.setResponses([validTranslatorResponse, validCrossValidationPass])

    await translatePolicy({
      intent: 'test',
      clauses: [{ index: 0, text: 'Must have results' }],
      llm,
      translatorModel: 'test-translator',
      crossValidatorModel: 'test-validator',
    })

    const firstCall = llm.calls[0]
    expect(firstCall.messages[0].content).toContain('[0] Must have results')
  })
})
