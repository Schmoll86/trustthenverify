/**
 * ObservationStore — local trust model from direct experience (§7).
 * In-memory store of counterparty observations for trust scoring.
 */

export interface Observation {
  outcome: 'success' | 'failure' | 'timeout'
  escrowId?: string
  verificationMethod?: string
  latencyMs?: number
  timestamp: number
}

export class ObservationStore {
  private store: Map<string, Observation[]> = new Map()

  /** Record an observation about a counterparty. */
  record(counterpartyPubkey: string, observation: Omit<Observation, 'timestamp'>): void {
    const obs: Observation = {
      ...observation,
      timestamp: Date.now(),
    }
    const existing = this.store.get(counterpartyPubkey) ?? []
    existing.push(obs)
    this.store.set(counterpartyPubkey, existing)
  }

  /** Get all observations for a counterparty. */
  getFor(counterpartyPubkey: string): Observation[] {
    return this.store.get(counterpartyPubkey) ?? []
  }

  /**
   * Compute a simple trust score for a counterparty.
   * Returns a value between 0 and 1, or null if no observations.
   *
   * Score = successes / total, with recency weighting.
   * Timeouts count as 0.5 (uncertain), failures as 0.
   */
  trustScore(counterpartyPubkey: string): number | null {
    const observations = this.store.get(counterpartyPubkey)
    if (!observations || observations.length === 0) return null

    const now = Date.now()
    const ONE_DAY = 86400000

    let weightedSum = 0
    let totalWeight = 0

    for (const obs of observations) {
      // Exponential decay: half-life of 7 days
      const ageInDays = (now - obs.timestamp) / ONE_DAY
      const weight = Math.exp(-0.099 * ageInDays) // ln(2)/7 ≈ 0.099

      let score: number
      switch (obs.outcome) {
        case 'success':
          score = 1
          break
        case 'timeout':
          score = 0.5
          break
        case 'failure':
          score = 0
          break
      }

      weightedSum += score * weight
      totalWeight += weight
    }

    return totalWeight > 0 ? weightedSum / totalWeight : null
  }

  /** Clear all observations. */
  clear(): void {
    this.store.clear()
  }
}
