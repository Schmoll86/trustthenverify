import { describe, it, expect, beforeEach } from 'vitest'
import { ObservationStore } from '../observations.js'

describe('ObservationStore', () => {
  let store: ObservationStore

  beforeEach(() => {
    store = new ObservationStore()
  })

  it('records and retrieves observations', () => {
    store.record('agent-1', { outcome: 'success', escrowId: 'e1' })
    store.record('agent-1', { outcome: 'failure', escrowId: 'e2' })

    const obs = store.getFor('agent-1')
    expect(obs).toHaveLength(2)
    expect(obs[0].outcome).toBe('success')
    expect(obs[1].outcome).toBe('failure')
  })

  it('returns empty array for unknown agent', () => {
    expect(store.getFor('unknown')).toEqual([])
  })

  it('returns null trust score for unknown agent', () => {
    expect(store.trustScore('unknown')).toBeNull()
  })

  it('computes trust score = 1.0 for all successes', () => {
    store.record('agent-1', { outcome: 'success' })
    store.record('agent-1', { outcome: 'success' })
    store.record('agent-1', { outcome: 'success' })

    const score = store.trustScore('agent-1')
    expect(score).toBeCloseTo(1.0, 2)
  })

  it('computes trust score = 0.0 for all failures', () => {
    store.record('agent-1', { outcome: 'failure' })
    store.record('agent-1', { outcome: 'failure' })

    const score = store.trustScore('agent-1')
    expect(score).toBeCloseTo(0.0, 2)
  })

  it('computes trust score ≈ 0.5 for all timeouts', () => {
    store.record('agent-1', { outcome: 'timeout' })
    store.record('agent-1', { outcome: 'timeout' })

    const score = store.trustScore('agent-1')
    expect(score).toBeCloseTo(0.5, 2)
  })

  it('computes mixed trust score', () => {
    // 2 success, 1 failure — roughly 2/3 ≈ 0.67
    store.record('agent-1', { outcome: 'success' })
    store.record('agent-1', { outcome: 'success' })
    store.record('agent-1', { outcome: 'failure' })

    const score = store.trustScore('agent-1')!
    expect(score).toBeGreaterThan(0.5)
    expect(score).toBeLessThan(0.8)
  })

  it('keeps observations per counterparty separate', () => {
    store.record('agent-1', { outcome: 'success' })
    store.record('agent-2', { outcome: 'failure' })

    expect(store.getFor('agent-1')).toHaveLength(1)
    expect(store.getFor('agent-2')).toHaveLength(1)
    expect(store.trustScore('agent-1')).toBeCloseTo(1.0, 2)
    expect(store.trustScore('agent-2')).toBeCloseTo(0.0, 2)
  })

  it('records optional fields', () => {
    store.record('agent-1', {
      outcome: 'success',
      escrowId: 'e1',
      verificationMethod: 'buyer_confirm',
      latencyMs: 150,
    })

    const obs = store.getFor('agent-1')
    expect(obs[0].escrowId).toBe('e1')
    expect(obs[0].verificationMethod).toBe('buyer_confirm')
    expect(obs[0].latencyMs).toBe(150)
    expect(obs[0].timestamp).toBeGreaterThan(0)
  })

  it('clears all observations', () => {
    store.record('agent-1', { outcome: 'success' })
    store.record('agent-2', { outcome: 'failure' })
    store.clear()

    expect(store.getFor('agent-1')).toEqual([])
    expect(store.getFor('agent-2')).toEqual([])
  })
})
