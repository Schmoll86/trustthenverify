/**
 * X402Service — USDC payment verification and settlement on Base L2.
 * Follows the StripeService/OnchainService dependency-injection pattern.
 *
 * Flow: Agent sends USDC to gateway EOA → TTV verifies on-chain receipt →
 * mints macaroon → holds custodially → settles to seller on release.
 */

import { SELECTORS, EVENT_TOPICS, buildCallData, encodeAddress, encodeUint256 } from './abi'
import { privateKeyToEthAddress, sendSignedTransaction } from './eth-utils'

// Base mainnet USDC (Circle official)
const DEFAULT_USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_DECIMALS = 6

export interface X402PaymentInstructions {
  gatewayAddress: string
  amountUsdc: string       // "5.50"
  amountUsdcRaw: string    // "5500000" (6 decimals)
  chainId: number          // 8453
  usdcContract: string
  escrowId: string
  nonce: string
  expiresAt: string
}

export interface VerifyResult {
  verified: boolean
  from: string
  to: string
  amount: bigint
  blockNumber: bigint
}

export interface MacaroonPayload {
  escrowId: string
  buyerAddress: string
  sellerAddress: string
  amountCents: number
  issuedAt: string
  expiresAt: string
  nonce: string
}

export interface X402Service {
  /** Generate payment instructions for a buyer. */
  generatePaymentInstructions(escrowId: string, amountCents: number, expiresAt: string): X402PaymentInstructions

  /** Verify an on-chain USDC transfer matches expectations. */
  verifyPayment(txHash: string, expectedFrom: string, expectedAmountUsdc: bigint, escrowId: string): Promise<VerifyResult>

  /** Mint a signed macaroon token for the buyer. */
  mintMacaroon(escrowId: string, buyerAddr: string, sellerAddr: string, amountCents: number, nonce: string): Promise<string>

  /** Verify a macaroon token's signature. Public/free. */
  verifyMacaroon(macaroon: string): Promise<{ valid: boolean; payload: MacaroonPayload | null }>

  /** Settle USDC to seller's address on release. */
  settleToSeller(sellerAddress: string, amountUsdc: bigint, escrowId: string): Promise<{ txHash: string }>

  /** Check USDC balance for an address on Base. */
  checkBalance(address: string): Promise<{ balance: string; balanceRaw: string }>

  /** Get the gateway EOA address. */
  getGatewayAddress(): Promise<string>
}

/** Real implementation: raw fetch() to Base RPC + @noble/secp256k1. */
export class RealX402Service implements X402Service {
  private rpcUrl: string
  private privateKey: string
  private chainId: number
  private usdcContract: string

  constructor(rpcUrl: string, privateKey: string, chainId: number, usdcContract?: string) {
    this.rpcUrl = rpcUrl
    this.privateKey = privateKey
    this.chainId = chainId
    this.usdcContract = usdcContract ?? DEFAULT_USDC_CONTRACT
  }

  private async rpcCall(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const json = await res.json() as { result?: unknown; error?: { message: string } }
    if (json.error) throw new Error(`RPC error: ${json.error.message}`)
    return json.result
  }

  private async ethCall(to: string, data: string): Promise<string> {
    return await this.rpcCall('eth_call', [{ to, data }, 'latest']) as string
  }

  async getGatewayAddress(): Promise<string> {
    return privateKeyToEthAddress(this.privateKey)
  }

  generatePaymentInstructions(escrowId: string, amountCents: number, expiresAt: string): X402PaymentInstructions {
    const amountUsdc = (amountCents / 100).toFixed(2)
    const amountUsdcRaw = String(BigInt(amountCents) * BigInt(10 ** (USDC_DECIMALS - 2)))
    const nonce = crypto.randomUUID()

    return {
      gatewayAddress: '', // Filled lazily by route handler (async getGatewayAddress)
      amountUsdc,
      amountUsdcRaw,
      chainId: this.chainId,
      usdcContract: this.usdcContract,
      escrowId,
      nonce,
      expiresAt,
    }
  }

  async verifyPayment(
    txHash: string,
    expectedFrom: string,
    expectedAmountUsdc: bigint,
    _escrowId: string,
  ): Promise<VerifyResult> {
    const receipt = await this.rpcCall('eth_getTransactionReceipt', [txHash]) as {
      status: string
      logs: Array<{ address: string; topics: string[]; data: string }>
      blockNumber: string
    } | null

    if (!receipt) {
      throw new Error('Transaction not found or not yet mined')
    }

    if (receipt.status !== '0x1') {
      throw new Error('Transaction reverted')
    }

    // Find USDC Transfer event: topic0 = Transfer(address,address,uint256) sig
    const transferSig = '0x' + EVENT_TOPICS['Transfer(address,address,uint256)']
    const gatewayAddr = await this.getGatewayAddress()
    const gatewayAddrPadded = '0x' + encodeAddress(gatewayAddr)

    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === this.usdcContract.toLowerCase() &&
        log.topics[0] === transferSig &&
        log.topics[2]?.toLowerCase() === gatewayAddrPadded.toLowerCase()
      ) {
        const from = '0x' + (log.topics[1]?.slice(26) ?? '')
        const amount = BigInt(log.data)
        const blockNumber = BigInt(receipt.blockNumber)

        // Verify sender and amount
        if (from.toLowerCase() !== expectedFrom.toLowerCase()) {
          throw new Error(`Transfer from ${from} does not match expected ${expectedFrom}`)
        }
        if (amount < expectedAmountUsdc) {
          throw new Error(`Transfer amount ${amount} less than expected ${expectedAmountUsdc}`)
        }

        return {
          verified: true,
          from,
          to: gatewayAddr,
          amount,
          blockNumber,
        }
      }
    }

    throw new Error('No matching USDC Transfer event found in transaction')
  }

  async mintMacaroon(
    escrowId: string,
    buyerAddr: string,
    sellerAddr: string,
    amountCents: number,
    nonce: string,
  ): Promise<string> {
    const { signAsync } = await import('@noble/secp256k1')
    const { keccak_256 } = await import('@noble/hashes/sha3.js')
    const { hexToBytes } = await import('@noble/hashes/utils.js')

    const payload: MacaroonPayload = {
      escrowId,
      buyerAddress: buyerAddr,
      sellerAddress: sellerAddr,
      amountCents,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      nonce,
    }

    const payloadJson = JSON.stringify(payload)
    const payloadB64 = btoa(payloadJson)
    const hash = keccak_256(new TextEncoder().encode(payloadJson))

    // Sign with gateway key (noble v3 recovered format)
    const sigBytes = await signAsync(hash, hexToBytes(this.privateKey), { prehash: false, format: 'recovered' }) as unknown as Uint8Array
    const sigB64 = btoa(String.fromCharCode(...sigBytes))

    return `${payloadB64}.${sigB64}`
  }

  async verifyMacaroon(macaroon: string): Promise<{ valid: boolean; payload: MacaroonPayload | null }> {
    try {
      const [payloadB64, sigB64] = macaroon.split('.')
      if (!payloadB64 || !sigB64) return { valid: false, payload: null }

      const payloadJson = atob(payloadB64)
      const payload = JSON.parse(payloadJson) as MacaroonPayload

      // Verify signature using noble secp256k1 recovery
      const { keccak_256 } = await import('@noble/hashes/sha3.js')
      const { recoverPublicKey, Point } = await import('@noble/secp256k1')
      const { bytesToHex } = await import('@noble/hashes/utils.js')

      const hash = keccak_256(new TextEncoder().encode(payloadJson))
      // sigRaw is recovery(1) || r(32) || s(32) — same format signAsync produces with format: 'recovered'
      const sigRaw = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0))

      const recoveredPub = recoverPublicKey(sigRaw, hash, { prehash: false })
      const recoveredPoint = Point.fromHex(bytesToHex(recoveredPub))
      const uncompressed = recoveredPoint.toBytes(false)
      const addrHash = keccak_256(uncompressed.slice(1))
      const recoveredAddr = '0x' + bytesToHex(addrHash.slice(12))

      // Derive gateway address from our key for comparison
      const gatewayAddr = await privateKeyToEthAddress(this.privateKey)

      if (recoveredAddr.toLowerCase() !== gatewayAddr.toLowerCase()) {
        return { valid: false, payload: null }
      }

      // Check expiry
      if (new Date(payload.expiresAt) < new Date()) {
        return { valid: false, payload: null }
      }

      return { valid: true, payload }
    } catch {
      return { valid: false, payload: null }
    }
  }

  async settleToSeller(sellerAddress: string, amountUsdc: bigint, _escrowId: string): Promise<{ txHash: string }> {
    // Build ERC-20 transfer(address, uint256) calldata
    const selector = SELECTORS['transfer(address,uint256)']
    const calldata = buildCallData(selector, encodeAddress(sellerAddress), encodeUint256(amountUsdc))

    // Send signed transaction to USDC contract
    const txHash = await this.sendTransaction(this.usdcContract, '0x' + calldata)
    return { txHash }
  }

  async checkBalance(address: string): Promise<{ balance: string; balanceRaw: string }> {
    const selector = SELECTORS['balanceOf(address)']
    const calldata = buildCallData(selector, encodeAddress(address))
    const result = await this.ethCall(this.usdcContract, '0x' + calldata)
    const raw = BigInt(result)
    const balance = (Number(raw) / 10 ** USDC_DECIMALS).toFixed(2)
    return { balance, balanceRaw: raw.toString() }
  }

  /** Build, sign, and broadcast an EIP-1559 transaction. */
  private async sendTransaction(to: string, data: string): Promise<string> {
    return sendSignedTransaction({
      rpcCall: this.rpcCall.bind(this),
      privateKey: this.privateKey,
      chainId: this.chainId,
      to,
      data,
      gasLimitFallback: 100_000n, // ERC-20 transfers are ~65k gas
    })
  }
}
