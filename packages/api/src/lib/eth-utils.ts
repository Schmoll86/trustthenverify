/**
 * Shared Ethereum utility functions used by both OnchainService and X402Service.
 * Extracts duplicated address derivation and EIP-1559 transaction signing.
 */

type RpcCallFn = (method: string, params: unknown[]) => Promise<unknown>

/**
 * Derive an Ethereum address from a secp256k1 private key.
 * keccak256(uncompressedPubKey[1:])[-20:]
 */
export async function privateKeyToEthAddress(privateKey: string): Promise<string> {
  const { getPublicKey, Point } = await import('@noble/secp256k1')
  const { keccak_256 } = await import('@noble/hashes/sha3.js')
  const { hexToBytes, bytesToHex } = await import('@noble/hashes/utils.js')

  const compressed = getPublicKey(hexToBytes(privateKey))
  const point = Point.fromHex(bytesToHex(compressed))
  const uncompressed = point.toBytes(false)
  const hash = keccak_256(uncompressed.slice(1))
  return '0x' + bytesToHex(hash.slice(12))
}

/**
 * Build, sign, and broadcast an EIP-1559 transaction via raw RPC calls.
 * Handles nonce fetching, gas estimation (with L2 optimization), signing
 * with noble secp256k1 v3, and broadcasting.
 */
export async function sendSignedTransaction(params: {
  rpcCall: RpcCallFn
  privateKey: string
  chainId: number
  to: string
  data: string
  gasLimitFallback?: bigint
}): Promise<string> {
  const { rpcCall, privateKey, chainId, to, data, gasLimitFallback = 1_000_000n } = params

  const { signAsync } = await import('@noble/secp256k1')
  const { keccak_256 } = await import('@noble/hashes/sha3.js')
  const { bytesToHex, hexToBytes } = await import('@noble/hashes/utils.js')
  const { rlpEncode, bigintToRlpBytes, hexToRlpBytes } = await import('./rlp')

  const sender = await privateKeyToEthAddress(privateKey)

  // 1. Get nonce
  const nonceHex = await rpcCall('eth_getTransactionCount', [sender, 'latest']) as string
  const nonce = BigInt(nonceHex)

  // 2. Estimate gas (with configurable fallback)
  let gasLimit: bigint
  try {
    const gasHex = await rpcCall('eth_estimateGas', [{ from: sender, to, data }]) as string
    gasLimit = BigInt(gasHex) * 120n / 100n // 20% buffer
  } catch {
    gasLimit = gasLimitFallback
  }

  // 3. Get base fee and compute EIP-1559 gas prices (L2-optimized)
  let maxPriorityFeePerGas: bigint
  let maxFeePerGas: bigint
  try {
    const gasPriceHex = await rpcCall('eth_gasPrice', []) as string
    const basePrice = BigInt(gasPriceHex)
    // On L2s (Base), base fee is sub-gwei. Use small tip + 3x headroom.
    maxPriorityFeePerGas = basePrice < 1_000_000_000n ? 1_000n : 1_500_000_000n
    maxFeePerGas = basePrice * 3n + maxPriorityFeePerGas
  } catch {
    maxPriorityFeePerGas = 1_000n
    maxFeePerGas = 100_000_000n // 0.1 gwei fallback for L2
  }

  // 4. Build EIP-1559 tx fields
  const chainIdBig = BigInt(chainId)
  const toBytes = hexToRlpBytes(to)
  const dataBytes = hexToRlpBytes(data)

  const txFields = [
    bigintToRlpBytes(chainIdBig),
    bigintToRlpBytes(nonce),
    bigintToRlpBytes(maxPriorityFeePerGas),
    bigintToRlpBytes(maxFeePerGas),
    bigintToRlpBytes(gasLimit),
    toBytes,
    bigintToRlpBytes(0n), // value = 0
    dataBytes,
    [], // accessList = empty
  ]

  // 5. Sign: keccak256(0x02 || rlpEncode(fields))
  const unsignedRlp = rlpEncode(txFields)
  const txForSigning = new Uint8Array([0x02, ...unsignedRlp])
  const txHash = keccak_256(txForSigning)

  // noble v3 'recovered' format: recovery(1) || r(32) || s(32)
  const sigBytes = await signAsync(txHash, hexToBytes(privateKey), { prehash: false, format: 'recovered' }) as unknown as Uint8Array
  const recovery = sigBytes[0] // EIP-1559 v is just 0 or 1, NOT +27
  const r = sigBytes.slice(1, 33)
  const s = sigBytes.slice(33, 65)

  // 6. Build signed tx: 0x02 || rlpEncode([...fields, v, r, s])
  const signedFields = [
    ...txFields,
    bigintToRlpBytes(BigInt(recovery)),
    r,
    s,
  ]
  const signedRlp = rlpEncode(signedFields)
  const signedTx = new Uint8Array([0x02, ...signedRlp])

  // 7. Broadcast
  return await rpcCall('eth_sendRawTransaction', ['0x' + bytesToHex(signedTx)]) as string
}
