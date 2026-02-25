import { describe, it, expect } from 'vitest'
import {
  adversaryPrompt,
  refinementPrompt,
  parseAdversaryResponse,
  parseRefinementResponse,
} from '../lib/argus-prompts'

describe('adversaryPrompt', () => {
  it('includes intent and formal spec', () => {
    const prompt = adversaryPrompt('Return valid URLs', { version: 1, constraints: [] })
    expect(prompt).toContain('Return valid URLs')
    expect(prompt).toContain('"version": 1')
    expect(prompt).toContain('PASSES all the formal constraints')
    expect(prompt).toContain('VIOLATES the stated intent')
  })
})

describe('refinementPrompt', () => {
  it('includes intent, spec, exploit, and explanation', () => {
    const prompt = refinementPrompt(
      'Return valid URLs',
      { version: 1, constraints: [] },
      { url: 'http://evil.com' },
      'URL is valid but malicious',
    )
    expect(prompt).toContain('Return valid URLs')
    expect(prompt).toContain('"version": 1')
    expect(prompt).toContain('http://evil.com')
    expect(prompt).toContain('URL is valid but malicious')
    expect(prompt).toContain('Tier 1 constraint types')
  })
})

describe('parseAdversaryResponse', () => {
  it('parses valid JSON response', () => {
    const raw = JSON.stringify({
      exploit: { name: 'test', value: 42 },
      explanation: 'Name is technically valid but meaningless',
    })

    const result = parseAdversaryResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.exploit).toEqual({ name: 'test', value: 42 })
    expect(result!.explanation).toBe('Name is technically valid but meaningless')
  })

  it('parses markdown code block', () => {
    const raw = `Here is my exploit:

\`\`\`json
{
  "exploit": { "data": "fake" },
  "explanation": "Passes type check but not semantically valid"
}
\`\`\`

That should work.`

    const result = parseAdversaryResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.exploit).toEqual({ data: 'fake' })
  })

  it('returns null for null exploit (no exploit found)', () => {
    const raw = JSON.stringify({
      exploit: null,
      explanation: 'No exploit found',
    })

    const result = parseAdversaryResponse(raw)
    expect(result).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(parseAdversaryResponse('I cannot generate exploits')).toBeNull()
    expect(parseAdversaryResponse('')).toBeNull()
    expect(parseAdversaryResponse('random text with no json')).toBeNull()
  })

  it('returns null for invalid exploit structure', () => {
    const raw = JSON.stringify({ exploit: 'not an object', explanation: 'test' })
    expect(parseAdversaryResponse(raw)).toBeNull()
  })

  it('returns null for missing explanation', () => {
    const raw = JSON.stringify({ exploit: { data: 'x' } })
    expect(parseAdversaryResponse(raw)).toBeNull()
  })

  it('extracts JSON embedded in text', () => {
    const raw = `Here's my analysis. The exploit is:
{"exploit": {"result": "bad"}, "explanation": "bypasses intent"}
That concludes my findings.`

    const result = parseAdversaryResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.exploit).toEqual({ result: 'bad' })
  })
})

describe('parseRefinementResponse', () => {
  it('parses valid refinement response', () => {
    const raw = JSON.stringify({
      formal_spec: {
        version: 1,
        constraints: [
          { id: 'c1', type: 'exists', target: '$.name', params: {} },
        ],
      },
      tier2_introduced: false,
    })

    const result = parseRefinementResponse(raw)
    expect(result).not.toBeNull()
    expect(result!.formalSpec.version).toBe(1)
    expect((result!.formalSpec as { constraints: unknown[] }).constraints).toHaveLength(1)
  })

  it('parses markdown code block', () => {
    const raw = `\`\`\`json
{
  "formal_spec": {
    "version": 1,
    "constraints": [
      { "id": "c1", "type": "exists", "target": "$.name", "params": {} }
    ]
  }
}
\`\`\``

    const result = parseRefinementResponse(raw)
    expect(result).not.toBeNull()
  })

  it('returns null for invalid version', () => {
    const raw = JSON.stringify({
      formal_spec: { version: 2, constraints: [] },
    })
    expect(parseRefinementResponse(raw)).toBeNull()
  })

  it('returns null for missing constraints', () => {
    const raw = JSON.stringify({
      formal_spec: { version: 1 },
    })
    expect(parseRefinementResponse(raw)).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(parseRefinementResponse('cannot refine')).toBeNull()
    expect(parseRefinementResponse('')).toBeNull()
  })

  it('returns null for missing formal_spec', () => {
    const raw = JSON.stringify({ constraints: [] })
    expect(parseRefinementResponse(raw)).toBeNull()
  })
})
