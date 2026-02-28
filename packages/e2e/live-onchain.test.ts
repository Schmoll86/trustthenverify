/**
 * Live on-chain E2E tests — Base Mainnet via api.trustthenverify.com.
 *
 * Tests the full on-chain escrow flow through the production API:
 *   1. Propose on-chain escrow with Ethereum addresses
 *   2. Seller accepts → API deploys EscrowInstance on Base Mainnet
 *   3. Verify contract exists and has correct state on-chain
 *
 * Uses smallest possible amounts ($0.01 = 1 cent) to minimize cost.
 *
 * Usage:
 *   cd packages/e2e
 *   npx vitest --run live-onchain.test.ts
 */

import { describe, it, expect } from 'vitest'
import {
  generateKeypair,
  signRequest,
  publicKeyToAddress,
} from '@trustthenverify/sdk'

const API_URL = 'https://api.trustthenverify.com'
const RPC_URL = 'https://base-mainnet.g.alchemy.com/v2/pSqXLT1kg-6HQ7rE7Gu9W'
const FACTORY_ADDRESS = '0xE1E21350E4807adB472fbBb904Cd2Da75Eb77e1e'
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// ── Helpers ──────────────────────────────────────────────────────────────────

async function authedFetch(
  method: string,
  path: string,
  body: unknown,
  keypair: ReturnType<typeof generateKeypair>,
) {
  const bodyStr = body ? JSON.stringify(body) : ''
  const timestamp = Math.floor(Date.now() / 1000)
  const sigPath = path.replace('/v2', '')
  const signature = await signRequest(keypair.privateKey, method, sigPath, bodyStr, timestamp)

  const headers: Record<string, string> = {
    'X-Agent-Pubkey': keypair.publicKey,
    'X-Agent-Timestamp': String(timestamp),
    'X-Agent-Signature': signature,
    'Content-Type': 'application/json',
  }

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : bodyStr || undefined,
  })

  const text = await res.text()
  let json: { data?: unknown; error?: { code: string; message: string }; meta?: unknown }
  try {
    json = JSON.parse(text)
  } catch {
    return { status: res.status, data: undefined, error: { code: 'PARSE_ERROR', message: text.slice(0, 200) }, meta: undefined }
  }
  return { status: res.status, data: json.data, error: json.error, meta: json.meta }
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await res.json() as { result?: unknown; error?: { message: string } }
  if (json.error) throw new Error(`RPC error: ${json.error.message}`)
  return json.result
}

async function ethCall(to: string, data: string): Promise<string> {
  return await rpcCall('eth_call', [{ to, data }, 'latest']) as string
}

function padLeft(hex: string, bytes: number): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  return clean.padStart(bytes * 2, '0')
}

function decodeAddress(hex: string): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  return '0x' + clean.slice(24, 64)
}

function decodeUint256(hex: string): bigint {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  return BigInt('0x' + clean.slice(0, 64))
}

// Function selectors (first 4 bytes of keccak256 of function signature)
const SELECTORS = {
  state: '0xc19d93fb',           // state()
  buyer: '0x7150d8ae',           // buyer()
  seller: '0x08551a53',          // seller()
  amount: '0xaa8c217c',          // amount()
  collateral: '0xd8dfeb45',      // collateral()
  usdc: '0x3e413bee',            // usdc()
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Live On-Chain — Base Mainnet', { timeout: 120_000 }, () => {
  const buyer = generateKeypair()
  const seller = generateKeypair()
  const buyerAddress = publicKeyToAddress(buyer.publicKey)
  const sellerAddress = publicKeyToAddress(seller.publicKey)

  let escrowId: string
  let contractAddress: string

  it('derives valid Ethereum addresses from agent keys', () => {
    expect(buyerAddress).toMatch(/^0x[0-9a-f]{40}$/)
    expect(sellerAddress).toMatch(/^0x[0-9a-f]{40}$/)
    expect(buyerAddress).not.toBe(sellerAddress)
    console.log('Buyer address: ', buyerAddress)
    console.log('Seller address:', sellerAddress)
  })

  it('EscrowFactory is deployed on Base Mainnet', async () => {
    const code = await rpcCall('eth_getCode', [FACTORY_ADDRESS, 'latest']) as string
    expect(code.length).toBeGreaterThan(10) // not '0x' (empty)
    console.log('Factory code length:', (code.length - 2) / 2, 'bytes')
  })

  it('gateway has ETH for gas', async () => {
    // Gateway address: 0x2299244F6c99E59A1f8197509030428030aaaff9
    const balHex = await rpcCall('eth_getBalance', ['0x2299244F6c99E59A1f8197509030428030aaaff9', 'latest']) as string
    const balWei = BigInt(balHex)
    const balEth = Number(balWei) / 1e18
    console.log('Gateway ETH balance:', balEth.toFixed(6), 'ETH')
    // Need at least ~0.00001 ETH for a single tx on Base
    expect(balWei).toBeGreaterThan(10_000_000_000_000n) // > 0.00001 ETH
  })

  it('registers buyer and seller agents', async () => {
    const { status: s1, error: e1 } = await authedFetch('POST', '/v2/agents', {
      publicKey: buyer.publicKey,
      name: 'live-onchain-buyer',
      capabilities: ['purchase'],
    }, buyer)
    if (s1 !== 201) console.log('buyer reg error:', e1)
    expect(s1).toBe(201)

    const { status: s2, error: e2 } = await authedFetch('POST', '/v2/agents', {
      publicKey: seller.publicKey,
      name: 'live-onchain-seller',
      capabilities: ['data-retrieval'],
    }, seller)
    if (s2 !== 201) console.log('seller reg error:', e2)
    expect(s2).toBe(201)
  })

  it('proposes on-chain escrow ($0.01 = 1 cent)', async () => {
    const { status, data, error: err } = await authedFetch('POST', '/v2/escrow/propose', {
      seller: seller.publicKey,
      amountCents: 1,
      sellerCollateral: 50,
      taskSpec: { type: 'data-retrieval', query: 'live on-chain test' },
      verificationMethod: 'buyer_confirm',
      fundingMode: 'onchain',
      buyerAddress,
      sellerAddress,
    }, buyer)
    if (status !== 201) console.log('propose error:', err)
    expect(status).toBe(201)

    const d = data as Record<string, unknown>
    expect(d.status).toBe('proposed')
    expect(d.fundingMode).toBe('onchain')
    expect(d.buyerAddress).toBe(buyerAddress)
    expect(d.sellerAddress).toBe(sellerAddress)
    escrowId = d.id as string
    console.log('Escrow ID:', escrowId)
  })

  it('seller accepts → contract deployed on Base Mainnet', async () => {
    const { status, data, error: err } = await authedFetch('POST', `/v2/escrow/${escrowId}/accept`, {}, seller)
    if (status !== 200) console.log('accept error:', err)
    expect(status).toBe(200)

    const d = data as Record<string, unknown>
    expect(d.status).toBe('accepted')
    expect(d.contractAddress).toBeTruthy()
    expect((d.contractAddress as string).startsWith('0x')).toBe(true)
    expect(d.txHash).toBeTruthy()
    expect((d.txHash as string).startsWith('0x')).toBe(true)

    contractAddress = d.contractAddress as string
    console.log('Contract address:', contractAddress)
    console.log('Deploy tx hash: ', d.txHash)
  })

  it('contract exists on Base Mainnet', async () => {
    // Wait a moment for the tx to be mined
    await new Promise(r => setTimeout(r, 3000))

    const code = await rpcCall('eth_getCode', [contractAddress, 'latest']) as string
    expect(code.length).toBeGreaterThan(10)
    console.log('EscrowInstance code length:', (code.length - 2) / 2, 'bytes')
  })

  it('contract state is Created (0)', async () => {
    const stateHex = await ethCall(contractAddress, SELECTORS.state)
    const state = decodeUint256(stateHex)
    expect(state).toBe(0n) // Created
    console.log('Contract state: Created (0)')
  })

  it('contract buyer matches agent address', async () => {
    const buyerHex = await ethCall(contractAddress, SELECTORS.buyer)
    const contractBuyer = decodeAddress(buyerHex).toLowerCase()
    expect(contractBuyer).toBe(buyerAddress.toLowerCase())
  })

  it('contract seller matches agent address', async () => {
    const sellerHex = await ethCall(contractAddress, SELECTORS.seller)
    const contractSeller = decodeAddress(sellerHex).toLowerCase()
    expect(contractSeller).toBe(sellerAddress.toLowerCase())
  })

  it('contract amount matches escrow (1 cent = 0.01 USDC = 10000)', async () => {
    const amountHex = await ethCall(contractAddress, SELECTORS.amount)
    const amount = decodeUint256(amountHex)
    // 1 cent * 10000 = 10,000 (6-decimal USDC)
    expect(amount).toBe(10_000n)
    console.log('Contract amount:', amount.toString(), 'USDC units (0.01 USDC)')
  })

  it('contract collateral matches escrow (50 cents = 0.50 USDC = 500000)', async () => {
    const collateralHex = await ethCall(contractAddress, SELECTORS.collateral)
    const collateral = decodeUint256(collateralHex)
    // sellerCollateral: 50 cents * 10000 = 500,000 (6-decimal USDC)
    expect(collateral).toBe(500_000n)
    console.log('Contract collateral:', collateral.toString(), 'USDC units (0.50 USDC)')
  })

  it('contract uses Base Mainnet USDC', async () => {
    const usdcHex = await ethCall(contractAddress, SELECTORS.usdc)
    const contractUsdc = decodeAddress(usdcHex).toLowerCase()
    expect(contractUsdc).toBe(USDC_ADDRESS.toLowerCase())
  })

  it('API reports escrow as accepted with contract details', async () => {
    const { status, data } = await authedFetch('GET', `/v2/escrow/${escrowId}`, null, buyer)
    expect(status).toBe(200)
    const d = data as Record<string, unknown>
    expect(d.status).toBe('accepted')
    expect(d.contractAddress).toBe(contractAddress)
    expect(d.fundingMode).toBe('onchain')
  })

  it('fund endpoint reports not yet funded', async () => {
    const { status, data, error: err } = await authedFetch('POST', `/v2/escrow/${escrowId}/fund`, {}, buyer)
    // Should return current state — not yet funded
    if (status === 200) {
      const d = data as Record<string, unknown>
      expect(d.status).toBe('accepted') // still accepted, not active
    } else {
      // Some error response is also acceptable — contract exists but no USDC deposited
      console.log('Fund check response:', status, err?.code)
      expect(status).toBeLessThan(500) // not a server error
    }
  })
})

// ── Factory Validation ──────────────────────────────────────────────────────

describe('Live On-Chain — Factory Verification', { timeout: 30_000 }, () => {
  const GATEWAY_ADDRESS = '0x2299244F6c99E59A1f8197509030428030aaaff9'

  it('factory authorizedGateway matches expected address', async () => {
    const result = await ethCall(FACTORY_ADDRESS, '0xa20ac5e9') // authorizedGateway()
    const gateway = decodeAddress(result).toLowerCase()
    expect(gateway).toBe(GATEWAY_ADDRESS.toLowerCase())
    console.log('Factory authorizedGateway:', gateway)
  })

  it('factory treasury matches expected address', async () => {
    const result = await ethCall(FACTORY_ADDRESS, '0x61d027b3') // treasury()
    const treasury = decodeAddress(result).toLowerCase()
    expect(treasury).toBe(GATEWAY_ADDRESS.toLowerCase())
    console.log('Factory treasury:', treasury)
  })

  it('factory usdc matches Base Mainnet USDC', async () => {
    const result = await ethCall(FACTORY_ADDRESS, '0x3e413bee') // usdc()
    const usdc = decodeAddress(result).toLowerCase()
    expect(usdc).toBe(USDC_ADDRESS.toLowerCase())
    console.log('Factory USDC:', usdc)
  })

  it('factory owner is gateway', async () => {
    const result = await ethCall(FACTORY_ADDRESS, '0x8da5cb5b') // owner()
    const owner = decodeAddress(result).toLowerCase()
    expect(owner).toBe(GATEWAY_ADDRESS.toLowerCase())
    console.log('Factory owner:', owner)
  })
})
