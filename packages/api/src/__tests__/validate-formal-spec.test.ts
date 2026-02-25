import { describe, it, expect } from 'vitest'
import { validateFormalSpec } from '../lib/validate-formal-spec'

describe('validateFormalSpec', () => {
  it('accepts valid spec with multiple constraint types', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'exists', target: '$.results', params: {} },
        { id: 'c2', type: 'count', target: '$.results', params: { min: 1 } },
        { id: 'c3', type: 'format', target: '$.results[*].url', params: { format: 'uri' } },
      ],
    }
    const result = validateFormalSpec(spec)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects non-object', () => {
    expect(validateFormalSpec(null).valid).toBe(false)
    expect(validateFormalSpec('string').valid).toBe(false)
    expect(validateFormalSpec([]).valid).toBe(false)
  })

  it('rejects wrong version', () => {
    const result = validateFormalSpec({ version: 2, constraints: [] })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('version must be 1')
  })

  it('rejects missing constraints array', () => {
    const result = validateFormalSpec({ version: 1 })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('constraints must be an array')
  })

  it('rejects duplicate constraint IDs', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'dup', type: 'exists', target: '$.a', params: {} },
        { id: 'dup', type: 'exists', target: '$.b', params: {} },
      ],
    }
    const result = validateFormalSpec(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('duplicate'))).toBe(true)
  })

  it('rejects target not starting with $', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'exists', target: 'results', params: {} },
      ],
    }
    const result = validateFormalSpec(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('target must start with $'))).toBe(true)
  })

  it('rejects unknown constraint type', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'unknown_type', target: '$.a', params: {} },
      ],
    }
    const result = validateFormalSpec(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('unknown constraint type'))).toBe(true)
  })

  it('rejects missing params', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'exists', target: '$.a' },
      ],
    }
    const result = validateFormalSpec(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('params is required'))).toBe(true)
  })

  it('validates compare needs operator + other_target', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'compare', target: '$.a', params: {} },
      ],
    }
    const result = validateFormalSpec(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('operator'))).toBe(true)
    expect(result.errors.some(e => e.includes('other_target'))).toBe(true)
  })

  it('validates format needs valid format name', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'format', target: '$.a', params: { format: 'invalid' } },
      ],
    }
    const result = validateFormalSpec(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('format must be'))).toBe(true)
  })

  it('validates regex needs pattern', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'regex', target: '$.a', params: {} },
      ],
    }
    const result = validateFormalSpec(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('pattern must be a string'))).toBe(true)
  })

  it('validates nested all/any/none constraint', () => {
    const spec = {
      version: 1,
      constraints: [
        {
          id: 'c1', type: 'all', target: '$.items', params: {
            constraint: { id: 'c1_inner', type: 'exists', target: '$.value', params: {} },
          },
        },
      ],
    }
    const result = validateFormalSpec(spec)
    expect(result.valid).toBe(true)
  })

  it('rejects nesting beyond depth 3', () => {
    const spec = {
      version: 1,
      constraints: [
        {
          id: 'c1', type: 'all', target: '$.a', params: {
            constraint: {
              id: 'c2', type: 'all', target: '$.b', params: {
                constraint: {
                  id: 'c3', type: 'all', target: '$.c', params: {
                    constraint: {
                      id: 'c4', type: 'all', target: '$.d', params: {
                        constraint: { id: 'c5', type: 'exists', target: '$.e', params: {} },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    }
    const result = validateFormalSpec(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('nesting depth'))).toBe(true)
  })

  it('validates overlap needs other_target and max_ratio', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'overlap', target: '$.a', params: {} },
      ],
    }
    const result = validateFormalSpec(spec)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('other_target'))).toBe(true)
    expect(result.errors.some(e => e.includes('max_ratio'))).toBe(true)
  })

  it('accepts valid type constraint', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'type', target: '$.name', params: { expected: 'string' } },
      ],
    }
    expect(validateFormalSpec(spec).valid).toBe(true)
  })

  it('rejects invalid type expected value', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'type', target: '$.name', params: { expected: 'int' } },
      ],
    }
    expect(validateFormalSpec(spec).valid).toBe(false)
  })
})
