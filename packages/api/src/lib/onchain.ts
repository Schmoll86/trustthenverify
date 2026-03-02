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
import { sendSignedTransaction } from './eth-utils'

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

  /** Build, sign, and broadcast an EIP-1559 transaction. */
  private async sendTransaction(to: string, data: string): Promise<string> {
    return sendSignedTransaction({
      rpcCall: this.rpcCall.bind(this),
      privateKey: this.privateKey,
      chainId: this.chainId,
      to,
      data,
      gasLimitFallback: 1_000_000n, // Factory deploys need higher gas
    })
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
