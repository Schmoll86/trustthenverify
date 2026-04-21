/**
 * Minimal EIP-1559 transaction signer for USDC payments on Base L2.
 *
 * Ported from packages/api/src/lib/rlp.ts + eth-utils.ts so the SDK is
 * self-contained — agents using @trustthenverify/sdk never need ethers.js
 * or web3 to pay an x402 escrow.
 *
 * Dependencies: @noble/secp256k1 + @noble/hashes (already SDK deps).
 * No network lib beyond global fetch.
 */

import { signAsync, getPublicKey, Point } from '@noble/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

// ── Constants ───────────────────────────────────────────────────────────────

export const BASE_MAINNET_CHAIN_ID = 8453
export const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const BASE_PUBLIC_RPC = 'https://mainnet.base.org'
const ERC20_TRANSFER_SELECTOR = 'a9059cbb' // keccak256("transfer(address,uint256)")[0:4]

// ── RLP encoder ─────────────────────────────────────────────────────────────

type RLPInput = Uint8Array | RLPInput[]

export function rlpEncode(input: RLPInput): Uint8Array {
  if (input instanceof Uint8Array) return encodeBytes(input)
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
  if (data.length === 1 && data[0] < 0x80) return data
  if (data.length <= 55) return concat([new Uint8Array([0x80 + data.length]), data])
  const lenBytes = encodeLength(data.length)
  return concat([new Uint8Array([0xb7 + lenBytes.length]), lenBytes, data])
}

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

function bigintToRlpBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0)
  const hex = value.toString(16)
  const padded = hex.length % 2 ? '0' + hex : hex
  return hexToBytes(padded)
}

function hexToRlpBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length === 0) return new Uint8Array(0)
  return hexToBytes(clean)
}

// ── ERC-20 calldata ─────────────────────────────────────────────────────────

/** Encode `transfer(to, amount)` calldata for an ERC-20 token. Returns 0x-prefixed hex. */
export function encodeErc20Transfer(to: string, amount: bigint): string {
  const toHex = (to.startsWith('0x') ? to.slice(2) : to).toLowerCase().padStart(64, '0')
  const amountHex = amount.toString(16).padStart(64, '0')
  return '0x' + ERC20_TRANSFER_SELECTOR + toHex + amountHex
}

// ── Address derivation ──────────────────────────────────────────────────────

/** Derive the Ethereum address from a 32-byte secp256k1 private key (hex). */
export function privateKeyToEthAddress(privateKey: string): string {
  const priv = hexToBytes(privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey)
  const compressed = getPublicKey(priv)
  const point = Point.fromHex(bytesToHex(compressed))
  const uncompressed = point.toBytes(false)
  const hash = keccak_256(uncompressed.slice(1))
  return '0x' + bytesToHex(hash.slice(12))
}

// ── RPC ─────────────────────────────────────────────────────────────────────

interface JsonRpcResponse<T> {
  result?: T
  error?: { code: number; message: string }
}

async function rpcCall<T = unknown>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as JsonRpcResponse<T>
  if (json.error) throw new Error(`RPC error (${json.error.code}): ${json.error.message}`)
  return json.result as T
}

// ── Transaction signing + broadcast ─────────────────────────────────────────

export interface SignAndSendOptions {
  privateKey: string
  to: string
  data: string
  chainId?: number
  rpcUrl?: string
  gasLimitFallback?: bigint
}

/**
 * Build, sign (EIP-1559 type 2), and broadcast a transaction. Returns txHash.
 * Value is always 0 — this helper is for contract calls, not bare ETH transfers.
 */
export async function signAndSendTransaction(opts: SignAndSendOptions): Promise<string> {
  const privateKey = opts.privateKey.startsWith('0x') ? opts.privateKey.slice(2) : opts.privateKey
  const chainId = opts.chainId ?? BASE_MAINNET_CHAIN_ID
  const rpcUrl = opts.rpcUrl ?? BASE_PUBLIC_RPC
  const gasLimitFallback = opts.gasLimitFallback ?? 100_000n

  const sender = privateKeyToEthAddress(privateKey)

  // 1. Nonce
  const nonceHex = await rpcCall<string>(rpcUrl, 'eth_getTransactionCount', [sender, 'latest'])
  const nonce = BigInt(nonceHex)

  // 2. Gas estimate (with buffer + fallback)
  let gasLimit: bigint
  try {
    const gasHex = await rpcCall<string>(rpcUrl, 'eth_estimateGas', [
      { from: sender, to: opts.to, data: opts.data },
    ])
    gasLimit = (BigInt(gasHex) * 120n) / 100n
  } catch {
    gasLimit = gasLimitFallback
  }

  // 3. EIP-1559 gas prices (Base L2-optimized)
  let maxPriorityFeePerGas: bigint
  let maxFeePerGas: bigint
  try {
    const gasPriceHex = await rpcCall<string>(rpcUrl, 'eth_gasPrice', [])
    const basePrice = BigInt(gasPriceHex)
    maxPriorityFeePerGas = basePrice < 1_000_000_000n ? 1_000n : 1_500_000_000n
    maxFeePerGas = basePrice * 3n + maxPriorityFeePerGas
  } catch {
    maxPriorityFeePerGas = 1_000n
    maxFeePerGas = 100_000_000n
  }

  // 4. Build tx fields
  const txFields: RLPInput = [
    bigintToRlpBytes(BigInt(chainId)),
    bigintToRlpBytes(nonce),
    bigintToRlpBytes(maxPriorityFeePerGas),
    bigintToRlpBytes(maxFeePerGas),
    bigintToRlpBytes(gasLimit),
    hexToRlpBytes(opts.to),
    bigintToRlpBytes(0n), // value
    hexToRlpBytes(opts.data),
    [], // accessList
  ]

  // 5. Sign: keccak256(0x02 || rlpEncode(fields))
  const unsignedRlp = rlpEncode(txFields)
  const preimage = new Uint8Array(unsignedRlp.length + 1)
  preimage[0] = 0x02
  preimage.set(unsignedRlp, 1)
  const txHash = keccak_256(preimage)

  const sigBytes = (await signAsync(txHash, hexToBytes(privateKey), {
    prehash: false,
    format: 'recovered',
  })) as unknown as Uint8Array
  const recovery = sigBytes[0]
  const r = sigBytes.slice(1, 33)
  const s = sigBytes.slice(33, 65)

  // 6. Assemble signed tx: 0x02 || rlpEncode([...fields, v, r, s])
  const signedFields = [...txFields, bigintToRlpBytes(BigInt(recovery)), r, s]
  const signedRlp = rlpEncode(signedFields)
  const signedTx = new Uint8Array(signedRlp.length + 1)
  signedTx[0] = 0x02
  signedTx.set(signedRlp, 1)

  // 7. Broadcast
  const sentTxHash = await rpcCall<string>(rpcUrl, 'eth_sendRawTransaction', [
    '0x' + bytesToHex(signedTx),
  ])
  return sentTxHash
}

/**
 * Send USDC on Base L2 from the given private key to `to`.
 *
 * High-level helper that composes encodeErc20Transfer + signAndSendTransaction.
 * Agents calling this only need to supply (privateKey, to, amount). Returns
 * txHash; does NOT wait for the receipt.
 *
 * @param amountUsdcRaw Amount in 6-decimal USDC units (1 USDC = 1_000_000n).
 */
export async function sendUsdc(params: {
  privateKey: string
  to: string
  amountUsdcRaw: bigint
  chainId?: number
  rpcUrl?: string
  usdcContract?: string
}): Promise<{ txHash: string }> {
  const data = encodeErc20Transfer(params.to, params.amountUsdcRaw)
  const txHash = await signAndSendTransaction({
    privateKey: params.privateKey,
    to: params.usdcContract ?? BASE_MAINNET_USDC,
    data,
    chainId: params.chainId,
    rpcUrl: params.rpcUrl,
    gasLimitFallback: 100_000n,
  })
  return { txHash }
}

/**
 * Poll for a tx receipt. Returns the receipt when the tx is mined, throws on
 * revert (status !== '0x1'), throws if not mined within deadlineMs.
 */
export async function waitForReceipt(
  txHash: string,
  opts: { rpcUrl?: string; deadlineMs?: number; pollIntervalMs?: number } = {},
): Promise<{ status: string; blockNumber: string; gasUsed: string }> {
  const rpcUrl = opts.rpcUrl ?? BASE_PUBLIC_RPC
  const deadline = Date.now() + (opts.deadlineMs ?? 60_000)
  const interval = opts.pollIntervalMs ?? 2_000

  while (Date.now() < deadline) {
    const receipt = await rpcCall<{ status: string; blockNumber: string; gasUsed: string } | null>(
      rpcUrl,
      'eth_getTransactionReceipt',
      [txHash],
    )
    if (receipt) {
      if (receipt.status !== '0x1') {
        throw new Error(`Transaction ${txHash} reverted on-chain (status ${receipt.status})`)
      }
      return receipt
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`Transaction ${txHash} not mined within ${opts.deadlineMs ?? 60_000}ms`)
}
