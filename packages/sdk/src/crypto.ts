import { getPublicKey, signAsync, verify } from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

import type { Keypair } from './index.js'

/** Generate a secp256k1 keypair. Private key NEVER leaves client. */
export function generateKeypair(): Keypair {
  const privateKeyBytes = new Uint8Array(32)
  crypto.getRandomValues(privateKeyBytes)
  const privateKey = bytesToHex(privateKeyBytes)
  const publicKeyBytes = getPublicKey(privateKeyBytes, true) // compressed
  const publicKey = bytesToHex(publicKeyBytes)
  return { publicKey, privateKey }
}

/** SHA-256 hash as hex string. */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  return bytesToHex(sha256(bytes))
}

/**
 * Build canonical string for signing per §9.2:
 * `${timestamp}\n${METHOD}\n${path}\n${SHA256(body_bytes)}`
 */
export function buildCanonicalString(
  method: string,
  path: string,
  body: string,
  timestamp: number,
): string {
  const bodyHash = sha256Hex(body)
  return `${timestamp}\n${method}\n${path}\n${bodyHash}`
}

/**
 * Sign a request per §9.2. Returns compact hex signature.
 * Uses signAsync which leverages WebCrypto for HMAC-SHA256 (RFC 6979).
 */
export async function signRequest(
  privateKey: string,
  method: string,
  path: string,
  body: string,
  timestamp: number,
): Promise<string> {
  const canonical = buildCanonicalString(method, path, body, timestamp)
  const msgHash = sha256(new TextEncoder().encode(canonical))
  const sigBytes = await signAsync(msgHash, hexToBytes(privateKey), { prehash: false })
  return bytesToHex(sigBytes)
}

/** Verify a signature. verify() is sync and only needs sha256 for prehash (which we skip). */
export function verifySignature(
  publicKey: string,
  signature: string,
  method: string,
  path: string,
  body: string,
  timestamp: number,
): boolean {
  const canonical = buildCanonicalString(method, path, body, timestamp)
  const msgHash = sha256(new TextEncoder().encode(canonical))
  return verify(hexToBytes(signature), msgHash, hexToBytes(publicKey), { prehash: false })
}
