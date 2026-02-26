/**
 * OnchainService — abstraction over Base L2 for on-chain escrow operations.
 * Mirrors StripeService pattern. Uses raw fetch() to RPC + @noble/secp256k1.
 * Per SPEC-v2 §8.
 */

import {
  SELECTORS,
  buildCallData,
  encodeBytes32,
  encodeAddress,
  encodeUint256,
  decodeUint256,
  decodeAddress,
  evmStateToStatus,
} from './abi'

export interface OnchainService {
  /** Deploy an EscrowInstance via factory CREATE2. Returns contract address + tx hash. */
  deployEscrow(params: {
    escrowId: string
    buyer: string
    seller: string
    amountUsdc: bigint
    collateralUsdc: bigint
    deadlineTimestamp: number
  }): Promise<{ contractAddress: string; txHash: string }>

  /** Check funding status of an on-chain escrow. */
  checkFunding(contractAddress: string): Promise<{
    state: string
    buyerFunded: boolean
    sellerFunded: boolean
  }>

  /** Submit gateway release signature to on-chain escrow. */
  gatewayRelease(params: {
    contractAddress: string
    escrowId: string
    resultDigest: string
    v: number
    r: string
    s: string
  }): Promise<{ txHash: string }>

  /** Submit gateway fail signature to on-chain escrow. */
  gatewayFail(params: {
    contractAddress: string
    escrowId: string
    resultDigest: string
    v: number
    r: string
    s: string
  }): Promise<{ txHash: string }>

  /** Trigger timeout on an expired on-chain escrow. */
  triggerTimeout(contractAddress: string): Promise<{ txHash: string }>

  /** Read the current state of a contract. */
  getContractState(contractAddress: string): Promise<string>
}

/** Real implementation: raw fetch() to Base RPC endpoint. */
export class RealOnchainService implements OnchainService {
  private rpcUrl: string
  private factoryAddress: string
  private privateKey: string
  private chainId: number

  constructor(rpcUrl: string, factoryAddress: string, privateKey: string, chainId: number) {
    this.rpcUrl = rpcUrl
    this.factoryAddress = factoryAddress
    this.privateKey = privateKey
    this.chainId = chainId
  }

  private async rpcCall(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
    })
    const json = await res.json() as { result?: unknown; error?: { message: string } }
    if (json.error) throw new Error(`RPC error: ${json.error.message}`)
    return json.result
  }

  private async ethCall(to: string, data: string): Promise<string> {
    return await this.rpcCall('eth_call', [{ to, data }, 'latest']) as string
  }

  async deployEscrow(params: {
    escrowId: string
    buyer: string
    seller: string
    amountUsdc: bigint
    collateralUsdc: bigint
    deadlineTimestamp: number
  }): Promise<{ contractAddress: string; txHash: string }> {
    const selector = SELECTORS['create(bytes32,address,address,uint256,uint256,uint256)']
    const calldata = buildCallData(
      selector,
      encodeBytes32(params.escrowId),
      encodeAddress(params.buyer),
      encodeAddress(params.seller),
      encodeUint256(params.amountUsdc),
      encodeUint256(params.collateralUsdc),
      encodeUint256(BigInt(params.deadlineTimestamp)),
    )

    // For MVP: use eth_sendRawTransaction with signed tx
    // This requires nonce management, gas estimation, etc.
    // Simplified: use the factory's predictAddress for the contract address
    const predictSelector = SELECTORS['predictAddress(bytes32,address,address,uint256,uint256,uint256)']
    const predictData = buildCallData(
      predictSelector,
      encodeBytes32(params.escrowId),
      encodeAddress(params.buyer),
      encodeAddress(params.seller),
      encodeUint256(params.amountUsdc),
      encodeUint256(params.collateralUsdc),
      encodeUint256(BigInt(params.deadlineTimestamp)),
    )
    const predictResult = await this.ethCall(this.factoryAddress, predictData)
    const contractAddress = decodeAddress(predictResult)

    // Send the actual deploy transaction
    const txHash = await this.sendTransaction(this.factoryAddress, calldata)

    return { contractAddress, txHash }
  }

  async checkFunding(contractAddress: string): Promise<{
    state: string
    buyerFunded: boolean
    sellerFunded: boolean
  }> {
    const stateData = buildCallData(SELECTORS['state()'])
    const stateResult = await this.ethCall(contractAddress, stateData)
    const stateNum = decodeUint256(stateResult)
    const state = evmStateToStatus(stateNum)

    // State-based funding detection:
    // BuyerFunded (1) = buyer funded, seller not yet
    // Active (2) = both funded
    const buyerFunded = stateNum >= 1n
    const sellerFunded = stateNum >= 2n

    return { state, buyerFunded, sellerFunded }
  }

  async gatewayRelease(params: {
    contractAddress: string
    escrowId: string
    resultDigest: string
    v: number
    r: string
    s: string
  }): Promise<{ txHash: string }> {
    const selector = SELECTORS['gatewayRelease(bytes32,bytes32,uint8,bytes32,bytes32)']
    const calldata = buildCallData(
      selector,
      encodeBytes32(params.escrowId),
      encodeBytes32(params.resultDigest),
      encodeUint256(BigInt(params.v)),
      encodeBytes32(params.r),
      encodeBytes32(params.s),
    )
    const txHash = await this.sendTransaction(params.contractAddress, calldata)
    return { txHash }
  }

  async gatewayFail(params: {
    contractAddress: string
    escrowId: string
    resultDigest: string
    v: number
    r: string
    s: string
  }): Promise<{ txHash: string }> {
    const selector = SELECTORS['gatewayFail(bytes32,bytes32,uint8,bytes32,bytes32)']
    const calldata = buildCallData(
      selector,
      encodeBytes32(params.escrowId),
      encodeBytes32(params.resultDigest),
      encodeUint256(BigInt(params.v)),
      encodeBytes32(params.r),
      encodeBytes32(params.s),
    )
    const txHash = await this.sendTransaction(params.contractAddress, calldata)
    return { txHash }
  }

  async triggerTimeout(contractAddress: string): Promise<{ txHash: string }> {
    const calldata = buildCallData(SELECTORS['timeout()'])
    const txHash = await this.sendTransaction(contractAddress, calldata)
    return { txHash }
  }

  async getContractState(contractAddress: string): Promise<string> {
    const stateData = buildCallData(SELECTORS['state()'])
    const result = await this.ethCall(contractAddress, stateData)
    return evmStateToStatus(decodeUint256(result))
  }

  /** Derive the sender address from the private key. */
  private async getSenderAddress(): Promise<string> {
    const { getPublicKey, Point } = await import('@noble/secp256k1')
    const { keccak_256 } = await import('@noble/hashes/sha3.js')
    const { hexToBytes, bytesToHex } = await import('@noble/hashes/utils.js')

    const compressed = getPublicKey(hexToBytes(this.privateKey))
    const point = Point.fromHex(bytesToHex(compressed))
    const uncompressed = point.toBytes(false)
    const hash = keccak_256(uncompressed.slice(1))
    return '0x' + bytesToHex(hash.slice(12))
  }

  /** Build, sign, and broadcast an EIP-1559 transaction. */
  private async sendTransaction(to: string, data: string): Promise<string> {
    const { signAsync } = await import('@noble/secp256k1')
    const { keccak_256 } = await import('@noble/hashes/sha3.js')
    const { bytesToHex, hexToBytes } = await import('@noble/hashes/utils.js')
    const { rlpEncode, bigintToRlpBytes, hexToRlpBytes } = await import('./rlp')

    const sender = await this.getSenderAddress()

    // 1. Get nonce
    const nonceHex = await this.rpcCall('eth_getTransactionCount', [sender, 'latest']) as string
    const nonce = BigInt(nonceHex)

    // 2. Estimate gas (with 1M fallback)
    let gasLimit: bigint
    try {
      const gasHex = await this.rpcCall('eth_estimateGas', [{
        from: sender,
        to,
        data,
      }]) as string
      // Add 20% buffer
      gasLimit = BigInt(gasHex) * 120n / 100n
    } catch {
      gasLimit = 1_000_000n
    }

    // 3. Get base fee and compute EIP-1559 gas prices
    const maxPriorityFeePerGas = 1_500_000_000n // 1.5 gwei
    let maxFeePerGas: bigint
    try {
      const gasPriceHex = await this.rpcCall('eth_gasPrice', []) as string
      const basePrice = BigInt(gasPriceHex)
      maxFeePerGas = basePrice * 2n + maxPriorityFeePerGas
    } catch {
      maxFeePerGas = 10_000_000_000n // 10 gwei fallback
    }

    // 4. Build EIP-1559 tx fields
    const chainId = BigInt(this.chainId)
    const toBytes = hexToRlpBytes(to)
    const dataBytes = hexToRlpBytes(data)

    const txFields = [
      bigintToRlpBytes(chainId),
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
    const sigBytes = await signAsync(txHash, hexToBytes(this.privateKey), { prehash: false, format: 'recovered' }) as unknown as Uint8Array
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
    const result = await this.rpcCall('eth_sendRawTransaction', [
      '0x' + bytesToHex(signedTx),
    ]) as string

    return result
  }
}

/**
 * Predict contract address locally without RPC call.
 * Uses CREATE2 formula: keccak256(0xff ++ factory ++ salt ++ keccak256(bytecode))
 */
export function predictContractAddress(
  factoryAddress: string,
  escrowId: string,
): string {
  // This is a simplified version — the actual prediction requires the full
  // init code hash which depends on constructor args. The real prediction
  // is done via the factory's predictAddress() view function.
  void factoryAddress; void escrowId
  throw new Error('Use OnchainService.deployEscrow() or factory.predictAddress() for address prediction')
}
