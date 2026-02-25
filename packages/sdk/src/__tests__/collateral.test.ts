import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TrustProtocol, generateKeypair, type Attestation } from '../index.js'

// Mock global fetch for queryAttestations calls
const mockFetch = vi.fn()
global.fetch = mockFetch

function createProtocol() {
  const kp = generateKeypair()
  return new TrustProtocol({
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    apiUrl: 'http://test-api',
  })
}

function makeAttestations(outcomes: string[]): Attestation[] {
  return outcomes.map((outcome, i) => ({
    id: `att-${i}`,
    authorId: 'author',
    subjectId: 'subject',
    escrowId: null,
    outcome,
    verificationMethod: null,
    signature: 'sig',
    nostrEventId: null,
    createdAt: new Date().toISOString(),
  }))
}

describe('suggestCollateral', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('no data -> { ratio: 0.5, confidence: low, dataPoints: 0 }', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    })

    const protocol = createProtocol()
    const result = await protocol.suggestCollateral('aa'.repeat(33), 10000)

    expect(result).toEqual({ suggestedRatio: 0.5, confidence: 'low', dataPoints: 0 })
  })

  it('local only, all successes -> low ratio, medium+ confidence', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    })

    const protocol = createProtocol()
    const pubkey = 'bb'.repeat(33)

    // Record 6 successes locally
    for (let i = 0; i < 6; i++) {
      protocol.recordObservation(pubkey, { outcome: 'success' })
    }

    const result = await protocol.suggestCollateral(pubkey, 10000)

    // High trust -> low ratio (close to 0.2 = 1.0 - 1.0 * 0.8)
    expect(result.suggestedRatio).toBeLessThan(0.3)
    expect(result.confidence).toBe('medium')
    expect(result.dataPoints).toBe(6)
  })

  it('local only, all failures -> high ratio', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    })

    const protocol = createProtocol()
    const pubkey = 'cc'.repeat(33)

    for (let i = 0; i < 5; i++) {
      protocol.recordObservation(pubkey, { outcome: 'failure' })
    }

    const result = await protocol.suggestCollateral(pubkey, 10000)

    // No trust -> high ratio (close to 1.0)
    expect(result.suggestedRatio).toBeGreaterThan(0.9)
    expect(result.dataPoints).toBe(5)
  })

  it('remote only -> uses remote data', async () => {
    const remoteAttestations = makeAttestations([
      'success', 'success', 'success', 'failure', 'success',
    ])
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: remoteAttestations }),
    })

    const protocol = createProtocol()
    const result = await protocol.suggestCollateral('dd'.repeat(33), 10000)

    // 4/5 success rate = 0.8 -> ratio = 1.0 - 0.8 * 0.8 = 0.36
    expect(result.suggestedRatio).toBeCloseTo(0.36, 1)
    expect(result.dataPoints).toBe(5)
    expect(result.confidence).toBe('medium')
  })

  it('blended: local weighted 2x over remote', async () => {
    // Remote: all failures (score = 0)
    const remoteAttestations = makeAttestations(['failure', 'failure', 'failure'])
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: remoteAttestations }),
    })

    const protocol = createProtocol()
    const pubkey = 'ee'.repeat(33)

    // Local: all successes (score ~ 1.0)
    for (let i = 0; i < 3; i++) {
      protocol.recordObservation(pubkey, { outcome: 'success' })
    }

    const result = await protocol.suggestCollateral(pubkey, 10000)

    // local=1.0 weight=2, remote=0.0 weight=1 -> blended = 2/3 ≈ 0.667
    // ratio = 1.0 - 0.667 * 0.8 ≈ 0.467
    expect(result.suggestedRatio).toBeCloseTo(0.467, 1)
    expect(result.dataPoints).toBe(6)
  })

  it('network failure on attestation query -> falls back to local only', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const protocol = createProtocol()
    const pubkey = 'ff'.repeat(33)

    for (let i = 0; i < 3; i++) {
      protocol.recordObservation(pubkey, { outcome: 'success' })
    }

    const result = await protocol.suggestCollateral(pubkey, 10000)

    // Should still work with local data only
    expect(result.dataPoints).toBe(3)
    expect(result.suggestedRatio).toBeLessThan(0.3)
    expect(result.confidence).toBe('low')
  })

  it('confidence tiers: <5 low, 5-19 medium, 20+ high', async () => {
    const protocol = createProtocol()
    const pubkey = 'aa'.repeat(33)

    // 3 data points -> low
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: makeAttestations(['success', 'success', 'success']) }) })
    const r1 = await protocol.suggestCollateral(pubkey, 10000)
    expect(r1.confidence).toBe('low')

    // 10 remote -> medium
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: makeAttestations(Array(10).fill('success')) }) })
    const r2 = await protocol.suggestCollateral(pubkey, 10000)
    expect(r2.confidence).toBe('medium')

    // 20+ -> high
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: makeAttestations(Array(20).fill('success')) }) })
    const r3 = await protocol.suggestCollateral(pubkey, 10000)
    expect(r3.confidence).toBe('high')
  })

  it('ratio clamped between 0.1 and 1.0', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: makeAttestations(Array(30).fill('success')) }),
    })

    const protocol = createProtocol()
    const pubkey = 'bb'.repeat(33)

    // Record many successes locally too
    for (let i = 0; i < 30; i++) {
      protocol.recordObservation(pubkey, { outcome: 'success' })
    }

    const result = await protocol.suggestCollateral(pubkey, 10000)

    // Perfect score = 1.0 -> ratio = 1.0 - 1.0 * 0.8 = 0.2, clamped min 0.1
    expect(result.suggestedRatio).toBeGreaterThanOrEqual(0.1)
    expect(result.suggestedRatio).toBeLessThanOrEqual(1.0)
  })
})
