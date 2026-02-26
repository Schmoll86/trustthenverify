import { describe, it, expect } from 'vitest'
import { rlpEncode, bigintToRlpBytes, hexToRlpBytes } from '../lib/rlp'
import { bytesToHex } from '@noble/hashes/utils.js'

describe('RLP encoder', () => {
  // Test vectors from Ethereum Yellow Paper / wiki

  it('encodes single byte < 0x80', () => {
    const result = rlpEncode(new Uint8Array([0x00]))
    expect(bytesToHex(result)).toBe('00')
  })

  it('encodes single byte = 0x7f', () => {
    const result = rlpEncode(new Uint8Array([0x7f]))
    expect(bytesToHex(result)).toBe('7f')
  })

  it('encodes single byte >= 0x80', () => {
    const result = rlpEncode(new Uint8Array([0x80]))
    expect(bytesToHex(result)).toBe('8180')
  })

  it('encodes empty byte string', () => {
    const result = rlpEncode(new Uint8Array(0))
    expect(bytesToHex(result)).toBe('80')
  })

  it('encodes short string "dog"', () => {
    const dog = new TextEncoder().encode('dog')
    const result = rlpEncode(dog)
    expect(bytesToHex(result)).toBe('83646f67')
  })

  it('encodes list ["cat", "dog"]', () => {
    const cat = new TextEncoder().encode('cat')
    const dog = new TextEncoder().encode('dog')
    const result = rlpEncode([cat, dog])
    expect(bytesToHex(result)).toBe('c88363617483646f67')
  })

  it('encodes empty list', () => {
    const result = rlpEncode([])
    expect(bytesToHex(result)).toBe('c0')
  })

  it('encodes nested lists', () => {
    // [ [], [[]], [ [], [[]] ] ]
    const result = rlpEncode([
      [],
      [[]],
      [[], [[]]]
    ])
    expect(bytesToHex(result)).toBe('c7c0c1c0c3c0c1c0')
  })

  it('encodes string of 55 bytes', () => {
    const data = new Uint8Array(55).fill(0x61) // 55 'a's
    const result = rlpEncode(data)
    // 0xb7 = 0x80 + 55, then the data
    expect(result[0]).toBe(0x80 + 55)
    expect(result.length).toBe(56)
  })

  it('encodes string of 56 bytes (long string)', () => {
    const data = new Uint8Array(56).fill(0x61)
    const result = rlpEncode(data)
    // 0xb8 = 0xb7 + 1 (length-of-length = 1 byte)
    expect(result[0]).toBe(0xb8)
    expect(result[1]).toBe(56)
    expect(result.length).toBe(58)
  })

  it('encodes integer 1024 via bigintToRlpBytes', () => {
    const bytes = bigintToRlpBytes(1024n)
    const result = rlpEncode(bytes)
    expect(bytesToHex(result)).toBe('820400')
  })

  it('encodes zero as empty bytes', () => {
    const bytes = bigintToRlpBytes(0n)
    expect(bytes.length).toBe(0)
    const result = rlpEncode(bytes)
    expect(bytesToHex(result)).toBe('80')
  })

  it('converts hex to bytes', () => {
    const bytes = hexToRlpBytes('0xdeadbeef')
    expect(bytesToHex(bytes)).toBe('deadbeef')
  })

  it('converts hex without prefix', () => {
    const bytes = hexToRlpBytes('abcd')
    expect(bytesToHex(bytes)).toBe('abcd')
  })

  it('converts empty hex to empty bytes', () => {
    const bytes = hexToRlpBytes('0x')
    expect(bytes.length).toBe(0)
  })
})
