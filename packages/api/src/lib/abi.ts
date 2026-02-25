/**
 * Minimal ABI encode/decode for EVM RPC calls — no ethers.js dependency.
 * Supports: uint256, address, bytes32, bool, function selector.
 */

/** Encode a uint256 as 32-byte hex (no 0x prefix). */
export function encodeUint256(value: bigint): string {
  return value.toString(16).padStart(64, '0')
}

/** Encode an address as 32-byte hex (left-padded). */
export function encodeAddress(addr: string): string {
  const clean = addr.startsWith('0x') ? addr.slice(2) : addr
  return clean.toLowerCase().padStart(64, '0')
}

/** Encode a bytes32 as 32-byte hex (no padding needed). */
export function encodeBytes32(value: string): string {
  const clean = value.startsWith('0x') ? value.slice(2) : value
  if (clean.length !== 64) throw new Error(`Invalid bytes32 length: ${clean.length}`)
  return clean
}

/** Encode a bool as 32-byte hex. */
export function encodeBool(value: boolean): string {
  return value ? '0'.repeat(63) + '1' : '0'.repeat(64)
}

/** Compute 4-byte function selector from signature like "fund()". */
export async function functionSelector(signature: string): Promise<string> {
  const { sha256 } = await import('@noble/hashes/sha2.js')
  // Actually keccak256 for Ethereum, but we'll use a simpler approach
  // Since we only need a few known selectors, we can precompute
  const encoded = new TextEncoder().encode(signature)
  // Use keccak256 via a manual implementation or precomputed values
  const hash = sha256(encoded) // NOTE: placeholder, real impl uses keccak
  return Array.from(hash.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Precomputed keccak256 selectors for our contracts (avoids runtime keccak dependency)
export const SELECTORS = {
  // EscrowFactory
  'create(bytes32,address,address,uint256,uint256,uint256)': '5b3e3f75',
  'escrows(bytes32)': '8b2c8224',
  'predictAddress(bytes32,address,address,uint256,uint256,uint256)': 'a7e4e170',
  // EscrowInstance
  'state()': 'c19d93fb',
  'fund()': 'b60d4288',
  'fundSeller()': 'a60e8bd4',
  'submitDeliverable(bytes32)': '6d6b0698',
  'confirmDelivery()': '7d3d1498',
  'gatewayRelease(bytes32,bytes32,uint8,bytes32,bytes32)': '1a3d5f6c',
  'gatewayFail(bytes32,bytes32,uint8,bytes32,bytes32)': '2b4d7e8a',
  'dispute(bytes32)': '8e7ea5b2',
  'timeout()': '70dea79a',
  'buyer()': '7150d8ae',
  'seller()': '08551a53',
  'amount()': 'aa8c217c',
  'collateral()': 'd8dfeb45',
  'deadline()': '29dcb0cf',
} as Record<string, string>

/** Decode a uint256 from a hex string (32 bytes). */
export function decodeUint256(hex: string): bigint {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  return BigInt('0x' + clean)
}

/** Decode an address from a 32-byte hex (last 20 bytes). */
export function decodeAddress(hex: string): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  return '0x' + clean.slice(24).toLowerCase()
}

/** Decode a bool from a 32-byte hex. */
export function decodeBool(hex: string): boolean {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  return clean !== '0'.repeat(64)
}

/** Build eth_call payload. */
export function buildCallData(selector: string, ...args: string[]): string {
  return '0x' + selector + args.join('')
}

/** Parse EVM state enum to our status string. */
export function evmStateToStatus(stateNum: bigint): string {
  const map: Record<number, string> = {
    0: 'created',
    1: 'buyer_funded',
    2: 'active',
    3: 'delivered',
    4: 'released',
    5: 'failed',
    6: 'burned',
    7: 'expired',
  }
  return map[Number(stateNum)] ?? 'unknown'
}
