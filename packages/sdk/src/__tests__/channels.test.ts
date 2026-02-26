import { describe, it, expect } from 'vitest'
import {
  signChannelPayment,
  verifyChannelPayment,
  publicKeyToAddress,
  encodeChannelClose,
} from '../channels'
import { getPublicKey } from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

describe('publicKeyToAddress', () => {
  it('derives correct Ethereum address from known private key', () => {
    // Well-known test vector: private key 1
    const privKey = '0000000000000000000000000000000000000000000000000000000000000001'
    const pubKey = bytesToHex(getPublicKey(hexToBytes(privKey)))
    const address = publicKeyToAddress(pubKey)

    // Address for private key 1 is well-known
    expect(address.toLowerCase()).toBe('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf')
  })

  it('handles 0x-prefixed public key', () => {
    const privKey = '0000000000000000000000000000000000000000000000000000000000000001'
    const pubKey = '0x' + bytesToHex(getPublicKey(hexToBytes(privKey)))
    const address = publicKeyToAddress(pubKey)
    expect(address).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it('produces 20-byte address', () => {
    const privKey = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    const pubKey = bytesToHex(getPublicKey(hexToBytes(privKey)))
    const address = publicKeyToAddress(pubKey)
    expect(address).toMatch(/^0x[0-9a-f]{40}$/)
  })
})

describe('signChannelPayment with keccak256', () => {
  const channelAddress = '0x' + 'ab'.repeat(20)

  it('produces 65-byte signature', async () => {
    const privKey = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    const pubKey = bytesToHex(getPublicKey(hexToBytes(privKey)))

    const payment = await signChannelPayment(privKey, channelAddress, 100000000n)
    expect(payment.signature).toHaveLength(130) // 65 bytes = 130 hex chars

    // v byte should be 27 or 28
    const sigBytes = hexToBytes(payment.signature)
    expect(sigBytes[64]).toBeGreaterThanOrEqual(27)
    expect(sigBytes[64]).toBeLessThanOrEqual(28)

    const valid = verifyChannelPayment(payment, pubKey)
    expect(valid).toBe(true)
  })

  it('round-trips sign + verify', async () => {
    const privKey = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    const pubKey = bytesToHex(getPublicKey(hexToBytes(privKey)))

    const payment = await signChannelPayment(privKey, channelAddress, 50000000n)
    expect(verifyChannelPayment(payment, pubKey)).toBe(true)
  })

  it('rejects wrong signer', async () => {
    const privKey1 = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    const privKey2 = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
    const pubKey2 = bytesToHex(getPublicKey(hexToBytes(privKey2)))

    const payment = await signChannelPayment(privKey1, channelAddress, 100n)
    expect(verifyChannelPayment(payment, pubKey2)).toBe(false)
  })
})

describe('encodeChannelClose', () => {
  it('produces valid calldata', () => {
    const sig = 'ab'.repeat(65) // 65 bytes
    const calldata = encodeChannelClose(100000000n, sig)
    // Should start with selector
    expect(calldata).toMatch(/^0xf65f53b3/)
    // Amount should be at offset 4+0
    expect(calldata.slice(10, 74)).toBe(100000000n.toString(16).padStart(64, '0'))
  })
})
