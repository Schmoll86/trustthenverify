/**
 * Minimal RLP (Recursive Length Prefix) encoder for Ethereum transactions.
 * Implements the encoding rules from the Ethereum Yellow Paper, Appendix B.
 */

export type RLPInput = Uint8Array | RLPInput[]

/** RLP-encode a single item or nested list. */
export function rlpEncode(input: RLPInput): Uint8Array {
  if (input instanceof Uint8Array) {
    return encodeBytes(input)
  }
  // It's a list
  const encoded = input.map(rlpEncode)
  const totalLength = encoded.reduce((acc, item) => acc + item.length, 0)
  const payload = concat(encoded)
  if (totalLength <= 55) {
    return concat([new Uint8Array([0xc0 + totalLength]), payload])
  }
  const lenBytes = encodeLength(totalLength)
  return concat([new Uint8Array([0xf7 + lenBytes.length]), lenBytes, payload])
}

function encodeBytes(data: Uint8Array): Uint8Array {
  // Single byte in [0x00, 0x7f]: encoded as itself
  if (data.length === 1 && data[0] < 0x80) {
    return data
  }
  // 0-55 bytes: 0x80 + length prefix
  if (data.length <= 55) {
    return concat([new Uint8Array([0x80 + data.length]), data])
  }
  // >55 bytes: 0xb7 + length-of-length prefix
  const lenBytes = encodeLength(data.length)
  return concat([new Uint8Array([0xb7 + lenBytes.length]), lenBytes, data])
}

/** Encode an integer length as big-endian bytes (no leading zeros). */
function encodeLength(len: number): Uint8Array {
  if (len === 0) return new Uint8Array([0])
  const bytes: number[] = []
  let remaining = len
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>= 8
  }
  return new Uint8Array(bytes)
}

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, arr) => acc + arr.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/** Convert a bigint to minimal big-endian bytes. Zero → empty bytes (RLP convention). */
export function bigintToRlpBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0)
  const hex = value.toString(16)
  const padded = hex.length % 2 ? '0' + hex : hex
  const bytes = new Uint8Array(padded.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** Convert a hex string (with or without 0x) to bytes. */
export function hexToRlpBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length === 0) return new Uint8Array(0)
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
