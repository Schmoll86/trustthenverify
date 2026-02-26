import { describe, it, expect } from 'vitest'
import { functionSelector, SELECTORS } from '../lib/abi'

describe('ABI function selectors', () => {
  it('computes correct keccak256 selector for fund()', async () => {
    const selector = await functionSelector('fund()')
    expect(selector).toBe(SELECTORS['fund()'])
  })

  it('computes correct selector for state()', async () => {
    const selector = await functionSelector('state()')
    expect(selector).toBe(SELECTORS['state()'])
  })

  it('computes correct selector for buyer()', async () => {
    const selector = await functionSelector('buyer()')
    expect(selector).toBe(SELECTORS['buyer()'])
  })

  it('computes correct selector for seller()', async () => {
    const selector = await functionSelector('seller()')
    expect(selector).toBe(SELECTORS['seller()'])
  })

  it('computes correct selector for amount()', async () => {
    const selector = await functionSelector('amount()')
    expect(selector).toBe(SELECTORS['amount()'])
  })

  it('computes correct selector for timeout()', async () => {
    const selector = await functionSelector('timeout()')
    expect(selector).toBe(SELECTORS['timeout()'])
  })

  it('computes correct selector for confirmDelivery()', async () => {
    const selector = await functionSelector('confirmDelivery()')
    expect(selector).toBe(SELECTORS['confirmDelivery()'])
  })

  it('selector is 4 bytes (8 hex chars)', async () => {
    const selector = await functionSelector('transfer(address,uint256)')
    expect(selector).toHaveLength(8)
    expect(selector).toMatch(/^[0-9a-f]{8}$/)
  })

  // Validate all precomputed selectors match keccak256
  it('all precomputed SELECTORS are correct', async () => {
    for (const [signature, expected] of Object.entries(SELECTORS)) {
      const computed = await functionSelector(signature)
      expect(computed, `Selector mismatch for ${signature}`).toBe(expected)
    }
  })
})
