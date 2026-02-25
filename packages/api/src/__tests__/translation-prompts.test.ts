import { describe, it, expect } from 'vitest'
import {
  translatorPrompt,
  crossValidationPrompt,
  parseTranslatorResponse,
  parseCrossValidationResponse,
} from '../lib/translation-prompts'

describe('translatorPrompt', () => {
  it('includes all four phases', () => {
    const prompt = translatorPrompt('Return 3 results with URLs')
    expect(prompt).toContain('Phase 1: Constraint Enumeration')
    expect(prompt).toContain('Phase 2: Attack Surface Analysis')
    expect(prompt).toContain('Phase 3: JSON Generation')
    expect(prompt).toContain('Phase 4: Self-Coverage Audit')
  })

  it('includes intent in prompt', () => {
    const prompt = translatorPrompt('Must return valid JSON with timestamps')
    expect(prompt).toContain('Must return valid JSON with timestamps')
  })

  it('includes pre-split clauses when provided', () => {
    const prompt = translatorPrompt('test intent', [
      { index: 0, text: 'Must have results' },
      { index: 1, text: 'Results must be recent' },
    ])
    expect(prompt).toContain('[0] Must have results')
    expect(prompt).toContain('[1] Results must be recent')
  })

  it('instructs model to split clauses when none provided', () => {
    const prompt = translatorPrompt('Return 3 results')
    expect(prompt).toContain('split the intent into individual clauses')
  })
})

describe('crossValidationPrompt', () => {
  it('includes all three questions', () => {
    const prompt = crossValidationPrompt(
      'Return results',
      { version: 1, constraints: [] },
      [{ index: 0, text: 'Return results', constraint_ids: ['c1'], status: 'covered' }],
    )
    expect(prompt).toContain('CONTRADICTIONS')
    expect(prompt).toContain('UNCOVERED CLAUSES')
    expect(prompt).toContain('EXPLOIT')
  })

  it('includes formal spec JSON', () => {
    const spec = { version: 1, constraints: [{ id: 'c1', type: 'exists', target: '$.x', params: {} }] }
    const prompt = crossValidationPrompt('test', spec, [])
    expect(prompt).toContain('"id": "c1"')
  })
})

describe('parseTranslatorResponse', () => {
  const validResponse = JSON.stringify({
    formal_spec: {
      version: 1,
      constraints: [{ id: 'c1', type: 'exists', target: '$.results', params: {} }],
    },
    clauses: [
      { index: 0, text: 'Must return results', constraint_ids: ['c1'], status: 'covered' },
    ],
    uncovered_clauses: [],
    attack_surfaces: ['Empty results array could pass exists check'],
  })

  it('parses valid JSON response', () => {
    const result = parseTranslatorResponse(validResponse)
    expect(result).not.toBeNull()
    expect(result!.formalSpec.version).toBe(1)
    expect(result!.formalSpec.constraints).toHaveLength(1)
    expect(result!.clauses).toHaveLength(1)
    expect(result!.clauses[0].status).toBe('covered')
  })

  it('parses markdown code block response', () => {
    const result = parseTranslatorResponse('Here is the result:\n```json\n' + validResponse + '\n```')
    expect(result).not.toBeNull()
    expect(result!.formalSpec.version).toBe(1)
  })

  it('parses JSON embedded in text', () => {
    const result = parseTranslatorResponse('After analysis, I found:\n' + validResponse + '\nThat covers everything.')
    expect(result).not.toBeNull()
    expect(result!.formalSpec.constraints).toHaveLength(1)
  })

  it('returns null for garbage', () => {
    expect(parseTranslatorResponse('This is not JSON at all')).toBeNull()
  })

  it('returns null for wrong version', () => {
    const bad = JSON.stringify({ formal_spec: { version: 2, constraints: [] }, clauses: [] })
    expect(parseTranslatorResponse(bad)).toBeNull()
  })

  it('returns null for missing constraints array', () => {
    const bad = JSON.stringify({ formal_spec: { version: 1 }, clauses: [] })
    expect(parseTranslatorResponse(bad)).toBeNull()
  })

  it('handles missing optional fields gracefully', () => {
    const minimal = JSON.stringify({
      formal_spec: { version: 1, constraints: [] },
    })
    const result = parseTranslatorResponse(minimal)
    expect(result).not.toBeNull()
    expect(result!.clauses).toHaveLength(0)
    expect(result!.uncoveredClauses).toHaveLength(0)
    expect(result!.attackSurfaces).toHaveLength(0)
  })
})

describe('parseCrossValidationResponse', () => {
  it('parses pass verdict', () => {
    const raw = JSON.stringify({
      contradictions: [],
      uncovered_clauses: [],
      exploit: null,
      verdict: 'pass',
    })
    const result = parseCrossValidationResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.verdict).toBe('pass')
    expect(result!.exploit).toBeNull()
  })

  it('parses fail verdict with exploit', () => {
    const raw = JSON.stringify({
      contradictions: ['c1 contradicts intent'],
      uncovered_clauses: ['clause 2 not covered'],
      exploit: { example: { results: [] }, explanation: 'Empty array passes' },
      verdict: 'fail',
    })
    const result = parseCrossValidationResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.verdict).toBe('fail')
    expect(result!.contradictions).toHaveLength(1)
    expect(result!.exploit).not.toBeNull()
    expect(result!.exploit!.explanation).toBe('Empty array passes')
  })

  it('returns null for invalid verdict', () => {
    const raw = JSON.stringify({ contradictions: [], uncovered_clauses: [], exploit: null, verdict: 'maybe' })
    expect(parseCrossValidationResponse(raw)).toBeNull()
  })

  it('returns null for garbage', () => {
    expect(parseCrossValidationResponse('not json')).toBeNull()
  })
})
