/**
 * Mock X402Service for tests. Records all calls for assertion.
 * Follows createMockStripe() / createMockOnchain() pattern.
 */

import type { X402Service, X402PaymentInstructions, VerifyResult, MacaroonPayload } from '../../lib/x402'

export interface X402Call {
  method: string
  params: Record<string, unknown>
}

export function createMockX402(options?: {
  verifyFail?: boolean
  settleFail?: boolean
}): X402Service & { calls: X402Call[]; reset(): void } {
  const calls: X402Call[] = []
  let counter = 0

  return {
    calls,
    reset() {
      calls.length = 0
      counter = 0
    },

    generatePaymentInstructions(escrowId, amountCents, expiresAt): X402PaymentInstructions {
      calls.push({ method: 'generatePaymentInstructions', params: { escrowId, amountCents, expiresAt } })
      return {
        gatewayAddress: '0x2299244F6c99E59A1f8197509030428030aaaff9',
        amountUsdc: (amountCents / 100).toFixed(2),
        amountUsdcRaw: String(BigInt(amountCents) * 10000n),
        chainId: 8453,
        usdcContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        escrowId,
        nonce: 'mock-nonce-' + ++counter,
        expiresAt,
      }
    },

    async verifyPayment(txHash, expectedFrom, expectedAmountUsdc, escrowId): Promise<VerifyResult> {
      calls.push({ method: 'verifyPayment', params: { txHash, expectedFrom, expectedAmountUsdc: expectedAmountUsdc.toString(), escrowId } })
      if (options?.verifyFail) {
        throw new Error('No matching USDC Transfer event found in transaction')
      }
      return {
        verified: true,
        from: expectedFrom,
        to: '0x2299244F6c99E59A1f8197509030428030aaaff9',
        amount: expectedAmountUsdc,
        blockNumber: 12345678n,
      }
    },

    async mintMacaroon(escrowId, buyerAddr, sellerAddr, amountCents, nonce): Promise<string> {
      calls.push({ method: 'mintMacaroon', params: { escrowId, buyerAddr, sellerAddr, amountCents, nonce } })
      return `mock_macaroon_${escrowId}`
    },

    async verifyMacaroon(macaroon): Promise<{ valid: boolean; payload: MacaroonPayload | null }> {
      calls.push({ method: 'verifyMacaroon', params: { macaroon } })
      if (macaroon.startsWith('mock_macaroon_')) {
        return {
          valid: true,
          payload: {
            escrowId: macaroon.replace('mock_macaroon_', ''),
            buyerAddress: '0x1111111111111111111111111111111111111111',
            sellerAddress: '0x2222222222222222222222222222222222222222',
            amountCents: 550,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            nonce: 'mock-nonce',
          },
        }
      }
      return { valid: false, payload: null }
    },

    async settleToSeller(sellerAddress, amountUsdc, escrowId): Promise<{ txHash: string }> {
      calls.push({ method: 'settleToSeller', params: { sellerAddress, amountUsdc: amountUsdc.toString(), escrowId } })
      if (options?.settleFail) {
        throw new Error('Settlement failed: insufficient gas')
      }
      return { txHash: `0x${'se'.repeat(32)}` }
    },

    async checkBalance(address): Promise<{ balance: string; balanceRaw: string }> {
      calls.push({ method: 'checkBalance', params: { address } })
      return { balance: '100.00', balanceRaw: '100000000' }
    },

    async getGatewayAddress(): Promise<string> {
      calls.push({ method: 'getGatewayAddress', params: {} })
      return '0x2299244F6c99E59A1f8197509030428030aaaff9'
    },
  }
}
