/**
 * Live Stripe smoke test — real money ($1 escrow).
 *
 * Usage:
 *   npx tsx live-smoke.ts
 *
 * This script:
 *   1. Registers buyer + seller agents on production API
 *   2. Creates Stripe Customer (buyer) + Express Account (seller)
 *   3. Creates a Checkout Session for buyer to add a card
 *   4. Prints seller onboarding URL
 *   5. Waits for both to complete
 *   6. Runs a $1 escrow: propose → accept → fund → deliver → confirm → release
 */

import {
  generateKeypair,
  signRequest,
} from '@trustthenverify/sdk'
import * as readline from 'readline'

const API_URL = 'https://api.trustthenverify.com/v2'
const STRIPE_PK = process.env.STRIPE_PUBLISHABLE_KEY ?? ''

const buyer = generateKeypair()
const seller = generateKeypair()

console.log('=== Live Stripe Smoke Test ===\n')
console.log('Buyer pubkey: ', buyer.publicKey.slice(0, 16) + '...')
console.log('Seller pubkey:', seller.publicKey.slice(0, 16) + '...')

// ── Helpers ──────────────────────────────────────────────────────────────────

async function authedFetch(
  method: string,
  path: string,
  body: unknown,
  keypair: typeof buyer,
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

  const res = await fetch(`https://api.trustthenverify.com${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : bodyStr || undefined,
  })

  const json = await res.json() as { data?: unknown; error?: { code: string; message: string } }
  if (!res.ok) {
    throw new Error(`${res.status} ${json.error?.code}: ${json.error?.message}`)
  }
  return json.data as Record<string, unknown>
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// ── Step 1: Register Agents ──────────────────────────────────────────────────

async function registerAgents() {
  console.log('\n--- Step 1: Register Agents ---')

  const buyerAgent = await authedFetch('POST', '/v2/agents', {
    publicKey: buyer.publicKey,
    name: 'live-smoke-buyer',
    capabilities: ['purchase'],
  }, buyer)
  console.log('Buyer registered:', (buyerAgent as Record<string, unknown>).id)

  const sellerAgent = await authedFetch('POST', '/v2/agents', {
    publicKey: seller.publicKey,
    name: 'live-smoke-seller',
    capabilities: ['data-retrieval'],
  }, seller)
  console.log('Seller registered:', (sellerAgent as Record<string, unknown>).id)
}

// ── Step 2: Stripe Setup ─────────────────────────────────────────────────────

async function setupStripe() {
  console.log('\n--- Step 2: Stripe Setup ---')

  // Buyer: create Stripe Customer
  const buyerResult = await authedFetch(
    'POST', `/v2/agents/${buyer.publicKey}/stripe/customer`, {}, buyer
  )
  const customerId = (buyerResult as Record<string, unknown>).stripeCustomerId
  console.log('Buyer Stripe Customer:', customerId)

  // Seller: create Express account
  const sellerResult = await authedFetch(
    'POST', `/v2/agents/${seller.publicKey}/stripe/connect`, {
      returnUrl: 'https://trustthenverify.com/onboarding/complete',
      refreshUrl: 'https://trustthenverify.com/onboarding/refresh',
    }, seller
  ) as { agent: Record<string, unknown>; onboardingUrl: string }
  console.log('Seller Express Account:', (sellerResult.agent as Record<string, unknown>).stripeConnectedAccountId)
  console.log('\n========================================')
  console.log('SELLER: Complete onboarding at this URL:')
  console.log(sellerResult.onboardingUrl)
  console.log('========================================\n')

  return { customerId: customerId as string }
}

// ── Step 3: Buyer Payment Method ─────────────────────────────────────────────

async function setupBuyerPaymentMethod(customerId: string) {
  console.log('\n--- Step 3: Buyer Payment Method ---')
  console.log('To attach a real card, you need to create a payment method via Stripe Elements or dashboard.')
  console.log(`Stripe Customer ID: ${customerId}`)
  console.log('\nOption A: Go to Stripe Dashboard → Customers → find this customer → Add payment method')
  console.log('Option B: Use Stripe CLI: stripe payment_methods create --type=card ...')

  const pmId = await prompt('\nPaste the payment method ID (pm_...): ')

  // Attach to agent
  await authedFetch(
    'POST', `/v2/agents/${buyer.publicKey}/stripe/payment-method`,
    { paymentMethodId: pmId }, buyer
  )
  console.log('Payment method attached:', pmId)
  return pmId
}

// ── Step 4: Wait for Seller Onboarding ───────────────────────────────────────

async function waitForSellerOnboarding() {
  console.log('\n--- Step 4: Waiting for Seller Onboarding ---')

  while (true) {
    const status = await authedFetch(
      'GET', `/v2/agents/${seller.publicKey}/stripe/status`, null, seller
    ) as { onboardingComplete: boolean; chargesEnabled: boolean; payoutsEnabled: boolean }

    if (status.onboardingComplete) {
      console.log('Seller onboarding complete! Charges:', status.chargesEnabled, 'Payouts:', status.payoutsEnabled)
      return
    }

    const answer = await prompt('Seller onboarding not complete yet. Press Enter to check again (or "skip" to continue anyway): ')
    if (answer === 'skip') return
  }
}

// ── Step 5: Run $1 Escrow ────────────────────────────────────────────────────

async function runEscrow() {
  console.log('\n--- Step 5: $1 Escrow Lifecycle ---')

  // Propose
  console.log('Proposing escrow ($1.00)...')
  const escrow = await authedFetch('POST', '/v2/escrow', {
    seller: seller.publicKey,
    amountCents: 100,
    taskSpec: { type: 'data-retrieval', query: 'live smoke test' },
    verificationMethod: 'buyer_confirm',
  }, buyer)
  const escrowId = escrow.id as string
  console.log('Escrow proposed:', escrowId)

  // Accept
  console.log('Seller accepting...')
  const accepted = await authedFetch('POST', `/v2/escrow/${escrowId}/accept`, {}, seller)
  console.log('Status:', (accepted as Record<string, unknown>).status)

  // Fund (Stripe captures the payment)
  console.log('Funding escrow...')
  const funded = await authedFetch('POST', `/v2/escrow/${escrowId}/fund`, {}, buyer)
  console.log('Status:', (funded as Record<string, unknown>).status)

  // Deliver
  console.log('Seller delivering...')
  const delivered = await authedFetch('POST', `/v2/escrow/${escrowId}/deliver`, {
    results: [
      { title: 'Live Smoke Test Result', url: 'https://example.com', snippet: 'Test passed' },
    ],
  }, seller)
  console.log('Status:', (delivered as Record<string, unknown>).status)

  // Confirm (buyer approves → releases funds)
  console.log('Buyer confirming delivery...')
  const released = await authedFetch('POST', `/v2/escrow/${escrowId}/confirm`, {}, buyer)
  console.log('Status:', (released as Record<string, unknown>).status)

  console.log('\n=== ESCROW COMPLETE ===')
  console.log(`Escrow ${escrowId}: $1.00 transferred from buyer to seller`)
  console.log('Check Stripe dashboard for the payment + transfer')
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await registerAgents()
    const { customerId } = await setupStripe()

    await prompt('\nComplete seller onboarding in your browser, then press Enter...')
    await waitForSellerOnboarding()
    await setupBuyerPaymentMethod(customerId)
    await runEscrow()

    console.log('\nDone! Check your Stripe dashboard:')
    console.log('https://dashboard.stripe.com/payments')
  } catch (err) {
    console.error('\nFailed:', (err as Error).message)
    process.exit(1)
  }
}

main()
