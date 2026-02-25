import { describe, it, expect } from 'vitest'
import { resolveTarget } from '../lib/jsonpath'

describe('resolveTarget', () => {
  const data = {
    name: 'test',
    results: [
      { url: 'https://a.com', score: 0.9 },
      { url: 'https://b.com', score: 0.8 },
    ],
    nested: { deep: { value: 42 } },
    tags: ['a', 'b', 'c'],
  }

  it('$ returns root', () => {
    expect(resolveTarget(data, '$')).toEqual([data])
  })

  it('$.field resolves top-level field', () => {
    expect(resolveTarget(data, '$.name')).toEqual(['test'])
  })

  it('$.nested.deep.value resolves nested field', () => {
    expect(resolveTarget(data, '$.nested.deep.value')).toEqual([42])
  })

  it('$.results[*].url fans out array', () => {
    expect(resolveTarget(data, '$.results[*].url')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })

  it('$.results[0].url resolves specific index', () => {
    expect(resolveTarget(data, '$.results[0].url')).toEqual(['https://a.com'])
  })

  it('$.results[1].score resolves second element', () => {
    expect(resolveTarget(data, '$.results[1].score')).toEqual([0.8])
  })

  it('$.tags[*] fans out primitive array', () => {
    expect(resolveTarget(data, '$.tags[*]')).toEqual(['a', 'b', 'c'])
  })

  it('missing path returns []', () => {
    expect(resolveTarget(data, '$.nonexistent')).toEqual([])
  })

  it('missing nested path returns []', () => {
    expect(resolveTarget(data, '$.a.b.c')).toEqual([])
  })

  it('[*] on non-array returns []', () => {
    expect(resolveTarget(data, '$.name[*]')).toEqual([])
  })

  it('out-of-bounds index returns []', () => {
    expect(resolveTarget(data, '$.results[99]')).toEqual([])
  })

  it('invalid path (no $) returns []', () => {
    expect(resolveTarget(data, 'results')).toEqual([])
  })

  it('works with null/undefined values', () => {
    expect(resolveTarget({ a: null }, '$.a')).toEqual([null])
    expect(resolveTarget(null, '$.a')).toEqual([])
  })
})
