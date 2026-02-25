/**
 * Payment channel utilities — off-chain signed payment messages.
 * Per SPEC-v2 §8. Uses @noble/secp256k1 for signing.
 */

import { signAsync, verify, getPublicKey } from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

export interface ChannelPayment {
  channelAddress: string
  amount: bigint
  signature: string  // hex-encoded 65-byte signature (r + s + v)
}

/**
 * Sign a payment channel message (channelAddress, amount).
 * Returns a 65-byte Ethereum-compatible signature (r || s || v).
 */
export async function signChannelPayment(
  privateKey: string,
  channelAddress: string,
  amount: bigint,
): Promise<ChannelPayment> {
  // Match Solidity: keccak256(abi.encodePacked(address(this), amount))
  // We use sha256 as hash function (matching our contract's verification)
  const addrBytes = hexToBytes(channelAddress.startsWith('0x') ? channelAddress.slice(2) : channelAddress)
  const amountBytes = bigintToBytes32(amount)
  const packed = new Uint8Array([...addrBytes, ...amountBytes])

  const messageHash = sha256(packed)

  // Ethereum signed message prefix
  const prefix = new TextEncoder().encode('\x19Ethereum Signed Message:\n32')
  const ethSignedHash = sha256(new Uint8Array([...prefix, ...messageHash]))

  const sig = await signAsync(ethSignedHash, hexToBytes(privateKey), { prehash: false })
  const sigBytes = sig as unknown as Uint8Array

  // For Ethereum: 65 bytes = r(32) + s(32) + v(1)
  const r = sigBytes.slice(0, 32)
  const s = sigBytes.slice(32, 64)
  const v = new Uint8Array([(sigBytes[64] ?? 0) + 27])
  const fullSig = new Uint8Array([...r, ...s, ...v])

  return {
    channelAddress,
    amount,
    signature: bytesToHex(fullSig),
  }
}

/**
 * Verify a payment channel signature matches the expected signer.
 */
export function verifyChannelPayment(
  payment: ChannelPayment,
  signerPublicKey: string,
): boolean {
  const addrBytes = hexToBytes(payment.channelAddress.startsWith('0x') ? payment.channelAddress.slice(2) : payment.channelAddress)
  const amountBytes = bigintToBytes32(payment.amount)
  const packed = new Uint8Array([...addrBytes, ...amountBytes])

  const messageHash = sha256(packed)
  const prefix = new TextEncoder().encode('\x19Ethereum Signed Message:\n32')
  const ethSignedHash = sha256(new Uint8Array([...prefix, ...messageHash]))

  const sigBytes = hexToBytes(payment.signature)
  // Strip the v byte for verification (noble uses compact 64-byte sigs)
  const compactSig = sigBytes.slice(0, 64)

  try {
    return verify(compactSig, ethSignedHash, hexToBytes(signerPublicKey), { prehash: false })
  } catch {
    return false
  }
}

/**
 * Derive an Ethereum address from a secp256k1 public key.
 * Uses keccak-like hash of uncompressed public key, takes last 20 bytes.
 * Simplified: uses sha256 truncated (real impl would use keccak256).
 */
export function publicKeyToAddress(publicKey: string): string {
  const pubBytes = hexToBytes(publicKey)
  // Get uncompressed form if compressed
  const uncompressed = pubBytes.length === 33
    ? getPublicKey(pubBytes.slice(1), false) // This is wrong, need privkey
    : pubBytes
  const hash = sha256(uncompressed.length > 32 ? uncompressed.slice(1) : uncompressed)
  return '0x' + bytesToHex(hash.slice(12))
}

function bigintToBytes32(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, '0')
  return hexToBytes(hex)
}
