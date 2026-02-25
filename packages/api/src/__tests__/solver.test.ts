import { describe, it, expect } from 'vitest'
import { solveConstraint, solveAll } from '../lib/solver'

describe('solveConstraint', () => {
  // ── exists ──
  describe('exists', () => {
    it('passes when value exists', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'exists', target: '$.name', params: {} },
        { name: 'test' },
      )
      expect(r.passed).toBe(true)
    })

    it('fails when value missing', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'exists', target: '$.missing', params: {} },
        { name: 'test' },
      )
      expect(r.passed).toBe(false)
    })

    it('fails when value is null', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'exists', target: '$.name', params: {} },
        { name: null },
      )
      expect(r.passed).toBe(false)
    })
  })

  // ── type ──
  describe('type', () => {
    it('passes for correct string type', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'type', target: '$.name', params: { expected: 'string' } },
        { name: 'hello' },
      )
      expect(r.passed).toBe(true)
    })

    it('passes for array type', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'type', target: '$.items', params: { expected: 'array' } },
        { items: [1, 2] },
      )
      expect(r.passed).toBe(true)
    })

    it('passes for object type', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'type', target: '$.data', params: { expected: 'object' } },
        { data: { a: 1 } },
      )
      expect(r.passed).toBe(true)
    })

    it('fails for wrong type', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'type', target: '$.name', params: { expected: 'number' } },
        { name: 'hello' },
      )
      expect(r.passed).toBe(false)
    })

    it('all values must match with [*]', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'type', target: '$.items[*]', params: { expected: 'number' } },
        { items: [1, 2, 'three'] },
      )
      expect(r.passed).toBe(false)
    })
  })

  // ── range ──
  describe('range', () => {
    it('passes within range', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'range', target: '$.score', params: { min: 0, max: 1 } },
        { score: 0.5 },
      )
      expect(r.passed).toBe(true)
    })

    it('fails below min', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'range', target: '$.score', params: { min: 0.8 } },
        { score: 0.5 },
      )
      expect(r.passed).toBe(false)
    })

    it('fails above max', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'range', target: '$.score', params: { max: 0.3 } },
        { score: 0.5 },
      )
      expect(r.passed).toBe(false)
    })

    it('handles date values with relative offset', () => {
      const recent = new Date(Date.now() - 10000).toISOString() // 10s ago
      const r = solveConstraint(
        { id: 'c1', type: 'range', target: '$.timestamp', params: { min: '-1h' } },
        { timestamp: recent },
      )
      expect(r.passed).toBe(true)
    })
  })

  // ── length ──
  describe('length', () => {
    it('passes string within length', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'length', target: '$.name', params: { min: 1, max: 10 } },
        { name: 'hello' },
      )
      expect(r.passed).toBe(true)
    })

    it('fails string too short', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'length', target: '$.name', params: { min: 10 } },
        { name: 'hi' },
      )
      expect(r.passed).toBe(false)
    })

    it('works with arrays', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'length', target: '$.items', params: { min: 2 } },
        { items: [1, 2, 3] },
      )
      expect(r.passed).toBe(true)
    })
  })

  // ── count ──
  describe('count', () => {
    it('passes array within count range', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'count', target: '$.results', params: { min: 2, max: 5 } },
        { results: [1, 2, 3] },
      )
      expect(r.passed).toBe(true)
    })

    it('fails when array too small', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'count', target: '$.results', params: { min: 5 } },
        { results: [1, 2] },
      )
      expect(r.passed).toBe(false)
    })

    it('fails on non-array', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'count', target: '$.name', params: { min: 1 } },
        { name: 'hello' },
      )
      expect(r.passed).toBe(false)
    })
  })

  // ── contains ──
  describe('contains', () => {
    it('passes when string contains value', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'contains', target: '$.text', params: { values: ['hello'] } },
        { text: 'hello world' },
      )
      expect(r.passed).toBe(true)
    })

    it('passes with any of values', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'contains', target: '$.text', params: { values: ['foo', 'world'] } },
        { text: 'hello world' },
      )
      expect(r.passed).toBe(true)
    })

    it('fails when no values found', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'contains', target: '$.text', params: { values: ['xyz'] } },
        { text: 'hello world' },
      )
      expect(r.passed).toBe(false)
    })
  })

  // ── regex ──
  describe('regex', () => {
    it('passes when pattern matches', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'regex', target: '$.email', params: { pattern: '^.+@.+\\..+$' } },
        { email: 'test@example.com' },
      )
      expect(r.passed).toBe(true)
    })

    it('fails when pattern does not match', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'regex', target: '$.email', params: { pattern: '^\\d+$' } },
        { email: 'not-a-number' },
      )
      expect(r.passed).toBe(false)
    })
  })

  // ── one_of ──
  describe('one_of', () => {
    it('passes when value in set', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'one_of', target: '$.status', params: { values: ['active', 'inactive'] } },
        { status: 'active' },
      )
      expect(r.passed).toBe(true)
    })

    it('fails when value not in set', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'one_of', target: '$.status', params: { values: ['active', 'inactive'] } },
        { status: 'deleted' },
      )
      expect(r.passed).toBe(false)
    })
  })

  // ── format ──
  describe('format', () => {
    it('passes valid URI', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'format', target: '$.url', params: { format: 'uri' } },
        { url: 'https://example.com' },
      )
      expect(r.passed).toBe(true)
    })

    it('fails invalid URI', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'format', target: '$.url', params: { format: 'uri' } },
        { url: 'not a url' },
      )
      expect(r.passed).toBe(false)
    })

    it('passes valid email', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'format', target: '$.email', params: { format: 'email' } },
        { email: 'test@example.com' },
      )
      expect(r.passed).toBe(true)
    })

    it('passes valid uuid', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'format', target: '$.id', params: { format: 'uuid' } },
        { id: '550e8400-e29b-41d4-a716-446655440000' },
      )
      expect(r.passed).toBe(true)
    })

    it('passes valid iso8601', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'format', target: '$.date', params: { format: 'iso8601' } },
        { date: '2025-01-15T10:30:00Z' },
      )
      expect(r.passed).toBe(true)
    })
  })

  // ── schema ──
  describe('schema', () => {
    it('validates against JSON schema', () => {
      const r = solveConstraint(
        {
          id: 'c1', type: 'schema', target: '$', params: {
            schema: {
              type: 'object',
              required: ['name', 'age'],
              properties: {
                name: { type: 'string', minLength: 1 },
                age: { type: 'number', minimum: 0 },
              },
            },
          },
        },
        { name: 'Alice', age: 30 },
      )
      expect(r.passed).toBe(true)
    })

    it('fails schema validation', () => {
      const r = solveConstraint(
        {
          id: 'c1', type: 'schema', target: '$', params: {
            schema: {
              type: 'object',
              required: ['name'],
            },
          },
        },
        { age: 30 },
      )
      expect(r.passed).toBe(false)
    })
  })

  // ── all ──
  describe('all', () => {
    it('passes when all elements satisfy constraint', () => {
      const r = solveConstraint(
        {
          id: 'c1', type: 'all', target: '$.items', params: {
            constraint: { id: 'inner', type: 'type', target: '$', params: { expected: 'number' } },
          },
        },
        { items: [1, 2, 3] },
      )
      expect(r.passed).toBe(true)
    })

    it('fails when any element violates', () => {
      const r = solveConstraint(
        {
          id: 'c1', type: 'all', target: '$.items', params: {
            constraint: { id: 'inner', type: 'type', target: '$', params: { expected: 'number' } },
          },
        },
        { items: [1, 'two', 3] },
      )
      expect(r.passed).toBe(false)
    })
  })

  // ── any ──
  describe('any', () => {
    it('passes when at least one element satisfies', () => {
      const r = solveConstraint(
        {
          id: 'c1', type: 'any', target: '$.items', params: {
            constraint: { id: 'inner', type: 'type', target: '$', params: { expected: 'string' } },
          },
        },
        { items: [1, 'two', 3] },
      )
      expect(r.passed).toBe(true)
    })

    it('fails when no element satisfies', () => {
      const r = solveConstraint(
        {
          id: 'c1', type: 'any', target: '$.items', params: {
            constraint: { id: 'inner', type: 'type', target: '$', params: { expected: 'string' } },
          },
        },
        { items: [1, 2, 3] },
      )
      expect(r.passed).toBe(false)
    })
  })

  // ── none ──
  describe('none', () => {
    it('passes when no element satisfies', () => {
      const r = solveConstraint(
        {
          id: 'c1', type: 'none', target: '$.items', params: {
            constraint: { id: 'inner', type: 'type', target: '$', params: { expected: 'string' } },
          },
        },
        { items: [1, 2, 3] },
      )
      expect(r.passed).toBe(true)
    })

    it('fails when any element satisfies', () => {
      const r = solveConstraint(
        {
          id: 'c1', type: 'none', target: '$.items', params: {
            constraint: { id: 'inner', type: 'type', target: '$', params: { expected: 'string' } },
          },
        },
        { items: [1, 'two', 3] },
      )
      expect(r.passed).toBe(false)
    })
  })

  // ── compare ──
  describe('compare', () => {
    it('passes gt comparison', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'compare', target: '$.a', params: { operator: 'gt', other_target: '$.b' } },
        { a: 10, b: 5 },
      )
      expect(r.passed).toBe(true)
    })

    it('fails gt comparison', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'compare', target: '$.a', params: { operator: 'gt', other_target: '$.b' } },
        { a: 3, b: 5 },
      )
      expect(r.passed).toBe(false)
    })

    it('passes eq comparison', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'compare', target: '$.a', params: { operator: 'eq', other_target: '$.b' } },
        { a: 5, b: 5 },
      )
      expect(r.passed).toBe(true)
    })

    it('passes neq comparison', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'compare', target: '$.a', params: { operator: 'neq', other_target: '$.b' } },
        { a: 5, b: 3 },
      )
      expect(r.passed).toBe(true)
    })
  })

  // ── overlap ──
  describe('overlap', () => {
    it('passes when overlap below threshold', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'overlap', target: '$.a', params: { other_target: '$.b', max_ratio: 0.5 } },
        { a: 'hello world', b: 'goodbye universe' },
      )
      expect(r.passed).toBe(true)
    })

    it('fails when overlap above threshold', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'overlap', target: '$.a', params: { other_target: '$.b', max_ratio: 0.1 } },
        { a: 'the quick brown fox', b: 'the quick brown dog' },
      )
      expect(r.passed).toBe(false)
    })

    it('passes identical strings with max_ratio=1', () => {
      const r = solveConstraint(
        { id: 'c1', type: 'overlap', target: '$.a', params: { other_target: '$.b', max_ratio: 1.0 } },
        { a: 'same', b: 'same' },
      )
      expect(r.passed).toBe(true)
    })
  })
})

// ── solveAll ──
describe('solveAll', () => {
  it('returns pass when all constraints pass', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'exists', target: '$.name', params: {} },
        { id: 'c2', type: 'type', target: '$.name', params: { expected: 'string' } },
      ],
    }
    const result = solveAll(spec, { name: 'hello' })
    expect(result.result).toBe('pass')
    expect(result.constraintsTotal).toBe(2)
    expect(result.constraintsPassed).toBe(2)
    expect(result.failures).toHaveLength(0)
  })

  it('returns fail when any constraint fails', () => {
    const spec = {
      version: 1,
      constraints: [
        { id: 'c1', type: 'exists', target: '$.name', params: {} },
        { id: 'c2', type: 'type', target: '$.name', params: { expected: 'number' } },
      ],
    }
    const result = solveAll(spec, { name: 'hello' })
    expect(result.result).toBe('fail')
    expect(result.constraintsPassed).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].id).toBe('c2')
  })

  it('handles empty constraints', () => {
    const result = solveAll({ version: 1, constraints: [] }, {})
    expect(result.result).toBe('pass')
    expect(result.constraintsTotal).toBe(0)
  })
})
