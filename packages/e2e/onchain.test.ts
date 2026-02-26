import { describe, it, expect } from 'vitest'
import {
  generateKeypair,
  createAgent,
  TrustProtocol,
  publicKeyToAddress,
} from '@trustthenverify/sdk'

const API_URL = process.env.E2E_API_URL ?? 'https://sandbox.trustthenverify.com/v2'
const SANDBOX_KEY = process.env.E2E_SANDBOX_KEY ?? ''

/**
 * E2E on-chain escrow tests — Base Sepolia.
 *
 * Prerequisites:
 *   - Contracts deployed to Base Sepolia (EscrowFactory + PaymentChannel)
 *   - Gateway EOA funded with Base Sepolia ETH
 *   - Test wallets funded with Base Sepolia ETH + USDC
 *   - Set env vars: E2E_API_URL, E2E_SANDBOX_KEY
 *
 * Run manually:
 *   cd packages/e2e
 *   E2E_API_URL=https://staging-api.trustthenverify.com/v2 \
 *   E2E_SANDBOX_KEY=<key> \
 *   npx vitest --run onchain.test.ts
 */

describe('E2E on-chain escrow — Base Sepolia', { timeout: 120_000 }, () => {
  const buyer = generateKeypair()
  const seller = generateKeypair()

  let buyerProto: TrustProtocol
  let sellerProto: TrustProtocol
  let escrowId: string

  it('registers buyer and seller agents', async () => {
    const buyerAgent = await createAgent({
      publicKey: buyer.publicKey,
      privateKey: buyer.privateKey,
      name: 'e2e-onchain-buyer',
      capabilities: ['purchase'],
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })
    expect(buyerAgent.publicKey).toBe(buyer.publicKey)

    buyerProto = new TrustProtocol({
      publicKey: buyer.publicKey,
      privateKey: buyer.privateKey,
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })

    const sellerAgent = await createAgent({
      publicKey: seller.publicKey,
      privateKey: seller.privateKey,
      name: 'e2e-onchain-seller',
      capabilities: ['data-retrieval'],
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })
    expect(sellerAgent.publicKey).toBe(seller.publicKey)

    sellerProto = new TrustProtocol({
      publicKey: seller.publicKey,
      privateKey: seller.privateKey,
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })
  })

  it('derives Ethereum addresses from agent keys', () => {
    const buyerAddr = publicKeyToAddress(buyer.publicKey)
    const sellerAddr = publicKeyToAddress(seller.publicKey)

    expect(buyerAddr).toMatch(/^0x[0-9a-f]{40}$/)
    expect(sellerAddr).toMatch(/^0x[0-9a-f]{40}$/)
    expect(buyerAddr).not.toBe(sellerAddr)
  })

  it('proposes on-chain escrow', async () => {
    const escrow = await buyerProto.proposeEscrow({
      seller: seller.publicKey,
      amountCents: 5000,
      taskSpec: { type: 'data-retrieval', query: 'quarterly earnings AAPL' },
      verificationMethod: 'buyer_confirm',
      fundingMode: 'onchain',
      buyerAddress: publicKeyToAddress(buyer.publicKey),
      sellerAddress: publicKeyToAddress(seller.publicKey),
    })

    expect(escrow.id).toBeTruthy()
    expect(escrow.status).toBe('proposed')
    expect(escrow.fundingMode).toBe('onchain')
    escrowId = escrow.id
  })

  it('seller accepts — contract deployed', async () => {
    const escrow = await sellerProto.acceptEscrow(escrowId)

    // In sandbox mode, contract deployment is mocked
    // In staging/prod, this deploys EscrowInstance via factory (CREATE2)
    expect(escrow.status).toBe('accepted')
  })

  // The following tests require real on-chain funding.
  // In sandbox mode, these will be skipped or mocked.

  it.skip('buyer funds contract with USDC', async () => {
    // Requires: buyer wallet funded with Base Sepolia USDC
    // Buyer sends USDC directly to the escrow contract address
    // Then notifies API:
    const escrow = await buyerProto.fundEscrow(escrowId, {
      txHash: '0x...', // actual funding tx hash
    })
    expect(escrow.status).toBe('funded')
  })

  it.skip('seller funds contract with collateral', async () => {
    // Requires: seller wallet funded with Base Sepolia USDC
    // Seller sends collateral USDC to the escrow contract
    // API cron detects both funded → activates
  })

  it.skip('deliver + confirm → on-chain release', async () => {
    // Seller delivers result
    await sellerProto.deliver(escrowId, {
      results: [
        { title: 'AAPL Q4 2025', url: 'https://example.com/aapl-q4', snippet: '$95.2B revenue' },
      ],
    })

    // Buyer confirms → gateway signs on-chain release
    const released = await buyerProto.confirmDelivery(escrowId)
    expect(released.status).toBe('released')
  })
})

describe('E2E payment channels', { timeout: 60_000 }, () => {
  const buyer = generateKeypair()
  const seller = generateKeypair()

  let buyerProto: TrustProtocol
  let sellerProto: TrustProtocol

  it('registers agents', async () => {
    await createAgent({
      publicKey: buyer.publicKey,
      privateKey: buyer.privateKey,
      name: 'e2e-channel-buyer',
      capabilities: ['purchase'],
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })
    buyerProto = new TrustProtocol({
      publicKey: buyer.publicKey,
      privateKey: buyer.privateKey,
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })

    await createAgent({
      publicKey: seller.publicKey,
      privateKey: seller.privateKey,
      name: 'e2e-channel-seller',
      capabilities: ['data-retrieval'],
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })
    sellerProto = new TrustProtocol({
      publicKey: seller.publicKey,
      privateKey: seller.privateKey,
      apiUrl: API_URL,
      sandbox: true,
      sandboxKey: SANDBOX_KEY,
    })
  })

  it('registers a payment channel', async () => {
    const channel = await buyerProto.registerChannel({
      channelAddress: '0x' + 'ab'.repeat(20),
      counterparty: seller.publicKey,
      depositAmount: 1000,
      chainId: 84532,
      expiryAt: '2026-12-31T23:59:59Z',
    })

    expect(channel.channelAddress).toBe('0x' + 'ab'.repeat(20))
    expect(channel.status).toBe('open')
  })

  it('reads channel details', async () => {
    const channel = await buyerProto.getChannel('0x' + 'ab'.repeat(20))
    expect(channel.depositAmount).toBe(1000)
  })

  it('seller can also read channel', async () => {
    const channel = await sellerProto.getChannel('0x' + 'ab'.repeat(20))
    expect(channel.status).toBe('open')
  })

  it('closes channel', async () => {
    const channel = await buyerProto.closeChannel('0x' + 'ab'.repeat(20))
    expect(channel.status).toBe('closed')
  })

  it('double close returns error', async () => {
    await expect(
      buyerProto.closeChannel('0x' + 'ab'.repeat(20))
    ).rejects.toThrow()
  })
})
