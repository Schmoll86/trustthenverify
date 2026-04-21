import { describe, it, expect } from 'vitest'
import {
  encodeErc20Transfer,
  privateKeyToEthAddress,
  rlpEncode,
  BASE_MAINNET_USDC,
  BASE_MAINNET_CHAIN_ID,
} from '../eth-tx.js'

describe('eth-tx — ERC-20 transfer calldata', () => {
  it('encodes transfer(to, amount) with selector 0xa9059cbb as first 4 bytes', () => {
    const to = '0xe93aea7fc6f7a24e02b6be584d30b9c3386876cb'
    const amount = 990_000n // 0.99 USDC (6 decimals)
    const calldata = encodeErc20Transfer(to, amount)

    expect(calldata.startsWith('0xa9059cbb')).toBe(true)
    expect(calldata.length).toBe(2 + 8 + 64 + 64) // 0x + selector(4B) + addr(32B) + amount(32B)

    // Recipient: left-padded to 32 bytes
    expect(calldata.slice(10, 74)).toBe('000000000000000000000000' + 'e93aea7fc6f7a24e02b6be584d30b9c3386876cb')

    // Amount: 990000 in hex = 0xf1b30
    expect(calldata.slice(74)).toBe('00000000000000000000000000000000000000000000000000000000000f1b30')
  })

  it('handles uppercase and mixed-case recipient addresses', () => {
    const mixed = '0xE93AEA7fc6f7a24e02B6bE584D30b9C3386876cb'
    const lower = '0xe93aea7fc6f7a24e02b6be584d30b9c3386876cb'
    expect(encodeErc20Transfer(mixed, 1n)).toBe(encodeErc20Transfer(lower, 1n))
  })

  it('zero amount still emits 32 bytes of padding', () => {
    const calldata = encodeErc20Transfer('0x' + '11'.repeat(20), 0n)
    expect(calldata.length).toBe(2 + 8 + 64 + 64)
    expect(calldata.endsWith('0'.repeat(64))).toBe(true)
  })
})

describe('eth-tx — address derivation', () => {
  // Known test vector — the trial's buyer keypair (throwaway, on-chain activity visible)
  const privateKey = '2696987ee77d146459fe87360e275cd22050f078ec4cf10619a871419618fdbb'
  const expectedAddress = '0x9b8483d3e12ffbf8f2a7f7934366f0a480d23de7'

  it('derives the correct Ethereum address from a known private key', () => {
    expect(privateKeyToEthAddress(privateKey)).toBe(expectedAddress)
  })

  it('tolerates 0x prefix on the private key', () => {
    expect(privateKeyToEthAddress('0x' + privateKey)).toBe(expectedAddress)
  })
})

describe('eth-tx — RLP encoder smoke', () => {
  it('encodes an empty list as 0xc0', () => {
    expect(Array.from(rlpEncode([]))).toEqual([0xc0])
  })

  it('encodes a single zero byte as itself', () => {
    expect(Array.from(rlpEncode(new Uint8Array([0])))).toEqual([0])
  })

  it('encodes "dog" (3 bytes) as 0x83 + dog', () => {
    const dog = new TextEncoder().encode('dog')
    expect(Array.from(rlpEncode(dog))).toEqual([0x83, ...dog])
  })
})

describe('eth-tx — exports', () => {
  it('exposes the canonical Base Mainnet USDC contract and chain id', () => {
    expect(BASE_MAINNET_USDC.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    expect(BASE_MAINNET_CHAIN_ID).toBe(8453)
  })
})
