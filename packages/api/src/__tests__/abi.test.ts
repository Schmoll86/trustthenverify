import { describe, it, expect } from 'vitest'
import { functionSelector, SELECTORS, buildCallData, encodeAddress, encodeUint256 } from '../lib/abi'
import { hexToRlpBytes } from '../lib/rlp'

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

  // Regression: 2026-04-21 live x402 trial caught "0x0x"-prefixed calldata
  // landing on-chain as 0x00a9059cbb... — unknown selector → revert. Root
  // cause: caller prepended another '0x' to buildCallData()'s already-prefixed
  // output, and hexToRlpBytes silently decoded the extra "0x" as byte 0x00.
  // This test asserts the end-to-end result: bytes fed into the tx input
  // MUST start with the real 4-byte function selector, never a spurious 0x00.
  it('settlement calldata decodes to selector-first bytes (no leading 0x00)', () => {
    const calldata = buildCallData(
      SELECTORS['transfer(address,uint256)'],
      encodeAddress('0xe93aea7fc6f7a24e02b6be584d30b9c3386876cb'),
      encodeUint256(990_000n),
    )
    const bytes = hexToRlpBytes(calldata)
    expect(bytes.length).toBe(4 + 32 + 32)
    expect(Array.from(bytes.slice(0, 4))).toEqual([0xa9, 0x05, 0x9c, 0xbb])
    expect(bytes[0]).not.toBe(0x00)
  })

  it('double-0x-prefixed input would produce the bug signature (documents the trap)', () => {
    // This test proves WHY the bug happened: hexToRlpBytes is permissive about
    // a doubled "0x" prefix and silently emits a leading zero byte. Anyone
    // tempted to re-introduce '0x' + buildCallData(...) will see this test
    // and understand the failure mode on-chain.
    const good = buildCallData(SELECTORS['transfer(address,uint256)'], encodeAddress('0x' + '11'.repeat(20)), encodeUint256(1n))
    const bad = '0x' + good // the bug — doubled 0x
    const badBytes = hexToRlpBytes(bad)
    expect(badBytes[0]).toBe(0x00) // NOT what we want — documents the hazard
    expect(Array.from(badBytes.slice(0, 5))).toEqual([0x00, 0xa9, 0x05, 0x9c, 0xbb])
  })
})
