/**
 * Verifies that LLM cost (OpenRouter usage.total_cost, rounded to USD cents)
 * propagates through the translation + arbitration services and surfaces on
 * their return values. Migration 014 adds ai_cost_cents columns; this test
 * covers everything up to the DB write boundary.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { translatePolicy } from '../lib/translation-service'
import { RealArbitrationService } from '../lib/arbitration-service'
import { createMockLLM } from './helpers/mock-llm'

const validTranslatorResponse = JSON.stringify({
  formal_spec: { version: 1, constraints: [] },
  clauses: [],
})

const validCrossValidationPass = JSON.stringify({
  verdict: 'pass',
  notes: 'looks good',
})

const validRuling = JSON.stringify({
  ruling: 'buyer_wins',
  rationale: 'Missing deliverable',
  confidence: 0.9,
})

describe('AI cost capture — translation', () => {
  const llm = createMockLLM()
  beforeEach(() => llm.reset())

  it('sums costCents across a translate + cross-validate (happy path)', async () => {
    llm.setResponses([
      { content: validTranslatorResponse, costCents: 7 },
      { content: validCrossValidationPass, costCents: 3 },
    ])

    const result = await translatePolicy({
      intent: 'do not return empty strings',
      llm,
      translatorModel: 'moonshotai/kimi-k2.5',
      crossValidatorModel: 'google/gemini-2.5-flash',
    })

    expect(result.status).toBe('validated')
    expect(result.costCents).toBe(10)
  })

  it('accumulates cost across retry attempts even when some fail', async () => {
    llm.setResponses([
      { content: 'not valid json', costCents: 4 },
      { content: validTranslatorResponse, costCents: 5 },
      { content: validCrossValidationPass, costCents: 3 },
    ])

    const result = await translatePolicy({
      intent: 'demo',
      llm,
      translatorModel: 'test-translator',
      crossValidatorModel: 'test-validator',
    })

    expect(result.status).toBe('validated')
    expect(result.costCents).toBe(12)
  })

  it('returns zero cost when the mock has no cost data', async () => {
    llm.setResponses([validTranslatorResponse, validCrossValidationPass])

    const result = await translatePolicy({
      intent: 'demo',
      llm,
      translatorModel: 't',
      crossValidatorModel: 'cv',
    })

    expect(result.costCents).toBe(0)
  })
})

describe('AI cost capture — arbitration', () => {
  const llm = createMockLLM()
  beforeEach(() => llm.reset())

  it('attaches costCents from a single successful arbitration call', async () => {
    llm.setResponse({ content: validRuling, costCents: 11 })

    const svc = new RealArbitrationService(llm, 'google/gemini-2.5-flash')
    const ruling = await svc.arbitrate({
      escrowId: 'esc-1',
      taskSpec: { foo: 'bar' },
      policy: null,
      verificationResults: null,
      disputeReason: 'no deliverable',
      initiatorRole: 'buyer',
      amountCents: 50,
      deliverable: null,
    })

    expect(ruling.ruling).toBe('buyer_wins')
    expect(ruling.costCents).toBe(11)
  })

  it('sums cost across parse-failure retry', async () => {
    llm.setResponses([
      { content: 'garbage not json', costCents: 4 },
      { content: validRuling, costCents: 6 },
    ])

    const svc = new RealArbitrationService(llm, 'google/gemini-2.5-flash')
    const ruling = await svc.arbitrate({
      escrowId: 'esc-2',
      taskSpec: {},
      policy: null,
      verificationResults: null,
      disputeReason: 'r',
      initiatorRole: 'seller',
      amountCents: 100,
      deliverable: null,
    })

    expect(ruling.costCents).toBe(10)
  })
})
