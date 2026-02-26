/**
 * Payment channel utilities — off-chain signed payment messages.
 * Per SPEC-v2 §8. Uses @noble/secp256k1 for signing.
 */

import { signAsync, verify, Point } from '@noble/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3.js'
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
  const addrBytes = hexToBytes(channelAddress.startsWith('0x') ? channelAddress.slice(2) : channelAddress)
  const amountBytes = bigintToBytes32(amount)
  const packed = new Uint8Array([...addrBytes, ...amountBytes])

  const messageHash = keccak_256(packed)

  // Ethereum signed message prefix
  const prefix = new TextEncoder().encode('\x19Ethereum Signed Message:\n32')
  const ethSignedHash = keccak_256(new Uint8Array([...prefix, ...messageHash]))

  // noble v3 'recovered' format: recovery(1) || r(32) || s(32)
  const sigBytes = await signAsync(ethSignedHash, hexToBytes(privateKey), { prehash: false, format: 'recovered' }) as unknown as Uint8Array

  // Reformat to Ethereum convention: r(32) || s(32) || v(1), where v = recovery + 27
  const recovery = sigBytes[0]
  const r = sigBytes.slice(1, 33)
  const s = sigBytes.slice(33, 65)
  const v = new Uint8Array([recovery + 27])
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

  const messageHash = keccak_256(packed)
  const prefix = new TextEncoder().encode('\x19Ethereum Signed Message:\n32')
  const ethSignedHash = keccak_256(new Uint8Array([...prefix, ...messageHash]))

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
 * Derive an Ethereum address from a secp256k1 public key (compressed or uncompressed).
 * keccak256(uncompressed[1:]) → last 20 bytes.
 */
export function publicKeyToAddress(publicKey: string): string {
  const clean = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey
  // Decompress if needed: Point.fromHex handles both compressed (33 bytes) and uncompressed (65 bytes)
  const point = Point.fromHex(clean)
  const uncompressed = point.toBytes(false) // 65 bytes: 0x04 + x(32) + y(32)
  // keccak256 of the 64-byte public key (skip the 0x04 prefix)
  const hash = keccak_256(uncompressed.slice(1))
  return '0x' + bytesToHex(hash.slice(12))
}

function bigintToBytes32(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, '0')
  return hexToBytes(hex)
}

// ── Calldata helpers for constructing raw transactions ──────────────────────

/** Encode calldata for PaymentChannel.close(uint256 amount, bytes signature). */
export function encodeChannelClose(amount: bigint, signature: string): string {
  const sig = signature.startsWith('0x') ? signature.slice(2) : signature
  // close(uint256,bytes) selector = keccak256("close(uint256,bytes)")[:4]
  const selector = 'f65f53b3'
  const amountHex = amount.toString(16).padStart(64, '0')
  // Dynamic bytes offset (2 * 32 = 64 bytes from start of params)
  const offset = '0000000000000000000000000000000000000000000000000000000000000040'
  // Bytes length (65 for Ethereum signature)
  const length = (sig.length / 2).toString(16).padStart(64, '0')
  // Bytes data padded to 32-byte boundary
  const padded = sig.padEnd(Math.ceil(sig.length / 64) * 64, '0')
  return '0x' + selector + amountHex + offset + length + padded
}
