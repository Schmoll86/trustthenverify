import { describe, it, expect } from 'vitest'
import { snakeToCamel, camelToSnake } from '../lib/case'

describe('snakeToCamel', () => {
  it('converts simple snake_case key: created_at -> createdAt', () => {
    const result = snakeToCamel<{ createdAt: string }>({ created_at: '2026-01-01' })
    expect(result).toEqual({ createdAt: '2026-01-01' })
  })

  it('converts multi-underscore: stripe_onboarding_complete -> stripeOnboardingComplete', () => {
    const result = snakeToCamel<{ stripeOnboardingComplete: boolean }>({
      stripe_onboarding_complete: true,
    })
    expect(result).toEqual({ stripeOnboardingComplete: true })
  })

  it('no-ops already camelCase keys', () => {
    const result = snakeToCamel<{ myKey: number }>({ myKey: 42 })
    expect(result).toEqual({ myKey: 42 })
  })

  it('recursively converts nested objects', () => {
    const result = snakeToCamel({
      buyer_id: 'x',
      task_spec: { query_text: 'test', max_results: 10 },
    })
    expect(result).toEqual({
      buyerId: 'x',
      taskSpec: { queryText: 'test', maxResults: 10 },
    })
  })

  it('converts arrays of objects', () => {
    const result = snakeToCamel([
      { first_name: 'Alice' },
      { first_name: 'Bob' },
    ])
    expect(result).toEqual([
      { firstName: 'Alice' },
      { firstName: 'Bob' },
    ])
  })

  it('passes null through unchanged', () => {
    expect(snakeToCamel(null)).toBeNull()
  })

  it('passes undefined through unchanged', () => {
    expect(snakeToCamel(undefined)).toBeUndefined()
  })

  it('passes primitives (strings, numbers, booleans) unchanged', () => {
    expect(snakeToCamel('hello')).toBe('hello')
    expect(snakeToCamel(42)).toBe(42)
    expect(snakeToCamel(true)).toBe(true)
  })

  it('handles empty object', () => {
    expect(snakeToCamel({})).toEqual({})
  })
})

describe('camelToSnake', () => {
  it('converts camelCase key: createdAt -> created_at', () => {
    const result = camelToSnake<{ created_at: string }>({ createdAt: '2026-01-01' })
    expect(result).toEqual({ created_at: '2026-01-01' })
  })

  it('recursively converts nested objects', () => {
    const result = camelToSnake({
      buyerId: 'x',
      taskSpec: { queryText: 'test' },
    })
    expect(result).toEqual({
      buyer_id: 'x',
      task_spec: { query_text: 'test' },
    })
  })

  it('converts arrays of objects', () => {
    const result = camelToSnake([
      { firstName: 'Alice' },
      { firstName: 'Bob' },
    ])
    expect(result).toEqual([
      { first_name: 'Alice' },
      { first_name: 'Bob' },
    ])
  })

  it('passes null through unchanged', () => {
    expect(camelToSnake(null)).toBeNull()
  })

  it('handles empty object', () => {
    expect(camelToSnake({})).toEqual({})
  })
})
