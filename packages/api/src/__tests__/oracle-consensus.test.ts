/**
 * Unit tests for oracle consensus logic — pure function, no DB.
 */

import { describe, it, expect } from 'vitest'
import { checkConsensus } from '../lib/oracle-service'

describe('checkConsensus', () => {
  const QUORUM = 3
  const TOTAL = 5

  // ── Early termination ──

  it('returns pass when 3 pass votes reached', () => {
    const result = checkConsensus(3, 0, QUORUM, TOTAL)
    expect(result.decided).toBe(true)
    expect(result.consensus).toBe('pass')
  })

  it('returns fail when 3 fail votes reached', () => {
    const result = checkConsensus(0, 3, QUORUM, TOTAL)
    expect(result.decided).toBe(true)
    expect(result.consensus).toBe('fail')
  })

  it('returns pass on 3-2 split (pass majority)', () => {
    const result = checkConsensus(3, 2, QUORUM, TOTAL)
    expect(result.decided).toBe(true)
    expect(result.consensus).toBe('pass')
  })

  it('returns fail on 2-3 split (fail majority)', () => {
    const result = checkConsensus(2, 3, QUORUM, TOTAL)
    expect(result.decided).toBe(true)
    expect(result.consensus).toBe('fail')
  })

  // ── Not yet decided ──

  it('not decided with 2 pass, 0 fail', () => {
    const result = checkConsensus(2, 0, QUORUM, TOTAL)
    expect(result.decided).toBe(false)
  })

  it('not decided with 1 pass, 1 fail', () => {
    const result = checkConsensus(1, 1, QUORUM, TOTAL)
    expect(result.decided).toBe(false)
  })

  it('not decided with 2 pass, 1 fail', () => {
    const result = checkConsensus(2, 1, QUORUM, TOTAL)
    expect(result.decided).toBe(false)
  })

  it('not decided with 0 pass, 2 fail', () => {
    const result = checkConsensus(0, 2, QUORUM, TOTAL)
    expect(result.decided).toBe(false)
  })

  // ── All voted scenarios ──

  it('returns pass on 4-1 split', () => {
    const result = checkConsensus(4, 1, QUORUM, TOTAL)
    expect(result.decided).toBe(true)
    expect(result.consensus).toBe('pass')
  })

  it('returns pass on unanimous 5-0', () => {
    const result = checkConsensus(5, 0, QUORUM, TOTAL)
    expect(result.decided).toBe(true)
    expect(result.consensus).toBe('pass')
  })

  it('returns fail on unanimous 0-5', () => {
    const result = checkConsensus(0, 5, QUORUM, TOTAL)
    expect(result.decided).toBe(true)
    expect(result.consensus).toBe('fail')
  })

  // ── Edge: impossible quorum ──

  it('returns no_consensus when neither side can reach quorum', () => {
    // 3 oracles total, quorum 3: if 1 pass, 1 fail, 1 remaining
    // pass can reach 2, fail can reach 2, neither reaches 3
    // Actually with 1 remaining: pass can get 2, fail can get 2
    // Need a case where remaining can't help either side
    const result = checkConsensus(1, 1, 3, 3)
    // 1 remaining: pass could get 2, fail could get 2 — neither reaches 3
    expect(result.decided).toBe(true)
    expect(result.consensus).toBe('no_consensus')
  })

  it('returns no_consensus on tie with even total', () => {
    // 4 oracles, quorum 3, result 2-2
    const result = checkConsensus(2, 2, 3, 4)
    expect(result.decided).toBe(true)
    expect(result.consensus).toBe('no_consensus')
  })

  // ── Custom quorum values ──

  it('works with quorum of 1 (any pass wins)', () => {
    const result = checkConsensus(1, 0, 1, 3)
    expect(result.decided).toBe(true)
    expect(result.consensus).toBe('pass')
  })

  it('works with quorum equal to total', () => {
    const result = checkConsensus(2, 0, 3, 3)
    expect(result.decided).toBe(false)
    // Need all 3 to pass
  })

  it('unanimous pass with quorum equal to total', () => {
    const result = checkConsensus(3, 0, 3, 3)
    expect(result.decided).toBe(true)
    expect(result.consensus).toBe('pass')
  })

  // ── Tallies are preserved ──

  it('preserves vote tallies in result', () => {
    const result = checkConsensus(3, 1, QUORUM, TOTAL)
    expect(result.votesPass).toBe(3)
    expect(result.votesFail).toBe(1)
  })

  // ── Zero votes ──

  it('not decided with zero votes', () => {
    const result = checkConsensus(0, 0, QUORUM, TOTAL)
    expect(result.decided).toBe(false)
  })
})
