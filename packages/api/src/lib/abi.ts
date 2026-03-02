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

/** Encode a bytes32 as 32-byte hex. Handles hex strings and UUIDs. */
export function encodeBytes32(value: string): string {
  const clean = value.startsWith('0x') ? value.slice(2) : value
  // Handle UUIDs: strip hyphens and right-pad to 64 hex chars
  const hex = clean.replace(/-/g, '')
  if (hex.length > 64) throw new Error(`Invalid bytes32 length: ${hex.length}`)
  return hex.padEnd(64, '0')
}

/** Encode a bool as 32-byte hex. */
export function encodeBool(value: boolean): string {
  return value ? '0'.repeat(63) + '1' : '0'.repeat(64)
}

/** Compute 4-byte function selector from signature like "fund()". */
export async function functionSelector(signature: string): Promise<string> {
  const { keccak_256 } = await import('@noble/hashes/sha3.js')
  const encoded = new TextEncoder().encode(signature)
  const hash = keccak_256(encoded)
  return Array.from(hash.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Precomputed keccak256 selectors for our contracts
export const SELECTORS = {
  // EscrowFactory
  'create(bytes32,address,address,uint256,uint256,uint256)': '745eab86',
  'escrows(bytes32)': '2d83549c',
  'predictAddress(bytes32,address,address,uint256,uint256,uint256)': '044082e3',
  // EscrowInstance
  'state()': 'c19d93fb',
  'fund()': 'b60d4288',
  'fundSeller()': '02b90c88',
  'submitDeliverable(bytes32)': 'b6ae44a5',
  'confirmDelivery()': '5e10177b',
  'gatewayRelease(bytes32,bytes32,uint8,bytes32,bytes32)': 'a8f6e9d3',
  'gatewayFail(bytes32,bytes32,uint8,bytes32,bytes32)': 'f19f5bd1',
  'dispute(bytes32)': 'add98c70',
  'timeout()': '70dea79a',
  'buyer()': '7150d8ae',
  'seller()': '08551a53',
  'amount()': 'aa8c217c',
  'collateral()': 'd8dfeb45',
  'deadline()': '29dcb0cf',
  // ERC-20 functions
  'transfer(address,uint256)': 'a9059cbb',
  'balanceOf(address)': '70a08231',
} as Record<string, string>

// Full keccak256 event topics (32 bytes, not truncated)
export const EVENT_TOPICS = {
  'Transfer(address,address,uint256)': 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
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
