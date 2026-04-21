/**
 * Live x402 End-to-End Commerce Trial — Base Mainnet, REAL USDC.
 *
 * First real-money E2E run of the x402 (USDC on Base) funding rail through the
 * production API. Budget: ~$1.50. Every phase persists state so a crash can
 * resume without re-paying or re-proposing.
 *
 * Flow:
 *   1. Setup     — generate/load keypairs, register agents, request funding
 *   2. Preflight — verify buyer EOA has USDC + ETH before spending anything
 *   3. Propose   — propose x402 escrow, capture payment instructions
 *   4. PAY       — single USDC.transfer() to gateway, then POST /x402-pay
 *   5. Execute   — seller accept → deliver → buyer confirm → poll for release
 *   6. Verify    — on-chain seller balance + settlement tx receipt
 *   7. Summary   — paper trail
 *   7.5 Sweep    — return residual USDC to a user-specified address
 *
 * Env:
 *   DRY_RUN=1      → stop after Phase 3 (before payment tx)
 *   SKIP_PAUSES=1  → auto-answer all pauses with empty string
 *
 * Usage:
 *   npx tsx packages/e2e/live-x402-trial.ts
 */

import {
  generateKeypair,
  createAgent,
  signRequest,
  TrustProtocol,
  publicKeyToAddress,
} from '@trustthenverify/sdk'
import { sendSignedTransaction } from '../api/src/lib/eth-utils'
import {
  SELECTORS,
  buildCallData,
  encodeAddress,
  encodeUint256,
  decodeUint256,
} from '../api/src/lib/abi'
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── Config ──────────────────────────────────────────────────────────────────

const API_URL = 'https://api.trustthenverify.com/v2'
const API_ORIGIN = 'https://api.trustthenverify.com'
const RPC_URL = 'https://base-mainnet.g.alchemy.com/v2/pSqXLT1kg-6HQ7rE7Gu9W'
const CHAIN_ID = 8453 // Base Mainnet
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const GATEWAY_ADDRESS = '0x2299244F6c99E59A1f8197509030428030aaaff9'

const STATE_FILE = path.join(import.meta.dirname ?? '.', '.x402-trial-state.json')

// Required for Phase 2 preflight.
const MIN_BUYER_USDC_RAW = 1_000_000n          // 1.00 USDC (6-decimal)
const MIN_BUYER_ETH_WEI  = 300_000_000_000_000n // 0.0003 ETH
const MIN_GATEWAY_ETH_WEI = 1_000_000_000_000_000n // 0.001 ETH (warn threshold)

type Phase =
  | 'init' | 'registered' | 'funded' | 'proposed'
  | 'paid' | 'delivered' | 'released' | 'swept'

interface TrialState {
  buyer: { publicKey: string; privateKey: string }
  seller: { publicKey: string; privateKey: string }
  phaseReached: Phase
  escrowId?: string
  buyerEthAddress?: string
  sellerEthAddress?: string
  paymentTxHash?: string
  settlementTxHash?: string
  expiresAt?: string
}

function loadState(): TrialState | null {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as TrialState
    }
  } catch { /* ignore */ }
  return null
}

function saveState(state: TrialState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

// ── Helpers (copied patterns from live-commerce-trial / live-onchain) ───────

function log(phase: string, msg: string): void {
  console.log(`\n[Phase ${phase}] ${msg}`)
}

function detail(label: string, value: unknown): void {
  console.log(`  ${label}: ${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}`)
}

function hr(): void {
  console.log('\n' + '─'.repeat(72))
}

async function pause(prompt: string): Promise<string> {
  if (process.env.SKIP_PAUSES) {
    console.log(`\n⏸  ${prompt}`)
    console.log('  [SKIP_PAUSES set, continuing...]')
    return ''
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`\n⏸  ${prompt}\n> `, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// ── Raw RPC (no viem/ethers — noble-only stack) ─────────────────────────────

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

async function usdcBalanceOf(address: string): Promise<bigint> {
  const data = buildCallData(SELECTORS['balanceOf(address)'], encodeAddress(address))
  const hex = await ethCall(USDC_ADDRESS, data)
  if (!hex || hex === '0x') return 0n
  return decodeUint256(hex)
}

async function ethBalanceOf(address: string): Promise<bigint> {
  const hex = await rpcCall('eth_getBalance', [address, 'latest']) as string
  return BigInt(hex)
}

// ── Authenticated API fetch (same pattern as live-commerce-trial) ──────────

interface ApiResponse<T = unknown> {
  status: number
  data: T | undefined
  error: { code: string; message: string } | undefined
  headers: Headers
}

async function authedFetch<T = unknown>(
  method: string,
  apiPath: string,
  body: unknown,
  keypair: { publicKey: string; privateKey: string },
): Promise<ApiResponse<T>> {
  const bodyStr = body ? JSON.stringify(body) : ''
  const timestamp = Math.floor(Date.now() / 1000)
  const sigPath = apiPath.replace('/v2', '')
  const signature = await signRequest(keypair.privateKey, method, sigPath, bodyStr, timestamp)

  const headers: Record<string, string> = {
    'X-Agent-Pubkey': keypair.publicKey,
    'X-Agent-Timestamp': String(timestamp),
    'X-Agent-Signature': signature,
    'Content-Type': 'application/json',
  }

  const res = await fetch(`${API_ORIGIN}${apiPath}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : bodyStr || undefined,
  })

  const text = await res.text()
  try {
    const json = JSON.parse(text) as { data?: T; error?: { code: string; message: string } }
    return { status: res.status, data: json.data, error: json.error, headers: res.headers }
  } catch {
    return {
      status: res.status,
      data: undefined,
      error: { code: 'PARSE_ERROR', message: text.slice(0, 200) },
      headers: res.headers,
    }
  }
}

// ── Phase 1: Setup ──────────────────────────────────────────────────────────

async function phase1Setup(): Promise<TrialState> {
  hr()
  console.log('PHASE 1: SETUP')

  const saved = loadState()
  let state: TrialState

  if (saved?.buyer && saved.seller) {
    log('1', 'Loaded saved keypairs from previous run')
    state = saved
  } else {
    log('1', 'Generating buyer + seller keypairs...')
    const buyer = generateKeypair()
    const seller = generateKeypair()
    state = { buyer, seller, phaseReached: 'init' }
    saveState(state)
  }

  state.buyerEthAddress = publicKeyToAddress(state.buyer.publicKey)
  state.sellerEthAddress = publicKeyToAddress(state.seller.publicKey)
  saveState(state)

  detail('Buyer pubkey  ', state.buyer.publicKey.slice(0, 20) + '...')
  detail('Buyer address ', state.buyerEthAddress)
  detail('Seller pubkey ', state.seller.publicKey.slice(0, 20) + '...')
  detail('Seller address', state.sellerEthAddress)

  // Register both — 409 is fine on re-run
  log('1', 'Registering buyer agent...')
  try {
    const buyerAgent = await createAgent({
      publicKey: state.buyer.publicKey,
      privateKey: state.buyer.privateKey,
      name: 'TrialBuyer-x402',
      capabilities: ['purchasing'],
    })
    detail('Buyer registered', { id: buyerAgent.id })
  } catch (e) {
    detail('Buyer registration', (e as Error).message + ' (likely already registered)')
  }

  log('1', 'Registering seller agent...')
  try {
    const sellerAgent = await createAgent({
      publicKey: state.seller.publicKey,
      privateKey: state.seller.privateKey,
      name: 'TrialSeller-x402',
      capabilities: ['echo'],
    })
    detail('Seller registered', { id: sellerAgent.id })
  } catch (e) {
    detail('Seller registration', (e as Error).message + ' (likely already registered)')
  }

  // Only prompt for funding if we haven't already advanced past this phase
  if (state.phaseReached === 'init') {
    hr()
    console.log('════════════════════════════════════════════════════════')
    console.log('HUMAN ACTION REQUIRED — Fund the buyer')
    console.log('════════════════════════════════════════════════════════')
    console.log('Send from your Base Mainnet wallet to:')
    console.log(`  Address:  ${state.buyerEthAddress}`)
    console.log(`  Network:  Base (chain ID ${CHAIN_ID})`)
    console.log(`  Tokens:   ~1.5 USDC (USDC contract: ${USDC_ADDRESS})`)
    console.log(`            + ~0.0005 ETH (for gas — 2-3 txns worth)`)
    console.log('════════════════════════════════════════════════════════')

    await pause('Press Enter when funds have arrived')
    state.phaseReached = 'registered'
    saveState(state)
  } else {
    detail('Phase', `already at ${state.phaseReached}, skipping funding prompt`)
  }

  return state
}

// ── Phase 2: Preflight ──────────────────────────────────────────────────────

async function phase2Preflight(state: TrialState): Promise<void> {
  hr()
  console.log('PHASE 2: PREFLIGHT (on-chain balance checks)')

  const buyerAddr = state.buyerEthAddress!
  const [buyerUsdc, buyerEth, gatewayUsdc, gatewayEth] = await Promise.all([
    usdcBalanceOf(buyerAddr),
    ethBalanceOf(buyerAddr),
    usdcBalanceOf(GATEWAY_ADDRESS),
    ethBalanceOf(GATEWAY_ADDRESS),
  ])

  detail('Buyer USDC  ', `${buyerUsdc.toString()} units (${Number(buyerUsdc) / 1e6} USDC)`)
  detail('Buyer ETH   ', `${buyerEth.toString()} wei (${Number(buyerEth) / 1e18} ETH)`)
  detail('Gateway USDC', `${gatewayUsdc.toString()} units (${Number(gatewayUsdc) / 1e6} USDC)`)
  detail('Gateway ETH ', `${gatewayEth.toString()} wei (${Number(gatewayEth) / 1e18} ETH)`)

  if (gatewayEth < MIN_GATEWAY_ETH_WEI) {
    console.log('\n⚠️  WARNING: gateway ETH is below 0.001 — settlement may fail due to insufficient gas on gateway EOA.')
  }

  const errors: string[] = []
  if (buyerUsdc < MIN_BUYER_USDC_RAW) {
    errors.push(`buyer EOA has ${buyerUsdc} USDC-raw, need ≥ ${MIN_BUYER_USDC_RAW} (1 USDC)`)
  }
  if (buyerEth < MIN_BUYER_ETH_WEI) {
    errors.push(`buyer EOA has ${buyerEth} wei ETH, need ≥ ${MIN_BUYER_ETH_WEI} (0.0003 ETH)`)
  }
  if (errors.length) {
    throw new Error('Preflight failed:\n  - ' + errors.join('\n  - '))
  }

  state.phaseReached = 'funded'
  saveState(state)
  log('2', 'Preflight passed')
}

// ── Phase 3: Propose escrow ─────────────────────────────────────────────────

interface X402Instr {
  gatewayAddress: string
  amountUsdc: string
  amountUsdcRaw: string
  chainId: number
  usdcContract: string
  escrowId: string
  nonce: string
  expiresAt: string
}

async function phase3Propose(state: TrialState): Promise<X402Instr> {
  hr()
  console.log('PHASE 3: PROPOSE ESCROW (x402)')

  if (state.escrowId && state.phaseReached !== 'funded' && state.phaseReached !== 'registered' && state.phaseReached !== 'init') {
    // Resuming — re-fetch escrow to get instructions back (expiresAt may have moved on but we can read)
    log('3', `Resuming existing escrow ${state.escrowId}`)
    const { status, data, error: err } = await authedFetch<Record<string, unknown>>(
      'GET', `/v2/escrow/${state.escrowId}`, null, state.buyer,
    )
    if (status !== 200 || !data) {
      throw new Error(`Cannot resume — GET /v2/escrow/${state.escrowId} returned ${status}: ${err?.message}`)
    }
    detail('Escrow status', data.status as string)
    // Synthesize instructions from state (we only need gateway/amountRaw for Phase 4 tx build)
    return {
      gatewayAddress: GATEWAY_ADDRESS,
      amountUsdc: '1.00',
      amountUsdcRaw: '1000000', // $0.01 * 100cents? No — amountCents=100 → 1 USDC
      chainId: CHAIN_ID,
      usdcContract: USDC_ADDRESS,
      escrowId: state.escrowId,
      nonce: '',
      expiresAt: state.expiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString(),
    }
  }

  const buyerProto = new TrustProtocol({
    publicKey: state.buyer.publicKey,
    privateKey: state.buyer.privateKey,
    apiUrl: API_URL,
  })

  log('3', 'Proposing x402 escrow (100 cents = $1.00, buyer_confirm)...')
  const result = await buyerProto.proposeEscrow({
    seller: state.seller.publicKey,
    amountCents: 100,
    collateralRatio: 0.5,
    taskSpec: {
      task: 'x402 trial: echo this string',
      echo: 'trustthenverify-x402-live-trial',
    },
    verificationMethod: 'buyer_confirm',
    fundingMode: 'x402',
  })

  const instr = (result as { x402PaymentInstructions?: X402Instr }).x402PaymentInstructions
  if (!instr) {
    throw new Error('API did not return x402PaymentInstructions')
  }

  // Persist immediately — this is the paper trail
  state.escrowId = result.id
  state.expiresAt = instr.expiresAt
  saveState(state)

  detail('Escrow ID    ', result.id)
  detail('Gateway addr ', instr.gatewayAddress)
  detail('Amount raw   ', `${instr.amountUsdcRaw} units (${instr.amountUsdc} USDC)`)
  detail('Expires at   ', instr.expiresAt)
  detail('Nonce        ', instr.nonce)

  // Sanity: gateway address must match hardcoded constant
  if (instr.gatewayAddress.toLowerCase() !== GATEWAY_ADDRESS.toLowerCase()) {
    throw new Error(
      `Gateway address mismatch! API returned ${instr.gatewayAddress}, ` +
      `expected ${GATEWAY_ADDRESS}. ABORTING before any money moves.`,
    )
  }

  // Sanity: expiry must be > now + 2 minutes
  const expiryMs = new Date(instr.expiresAt).getTime()
  const minExpiryMs = Date.now() + 2 * 60_000
  if (expiryMs < minExpiryMs) {
    throw new Error(
      `Escrow expires too soon: ${instr.expiresAt} (need > ${new Date(minExpiryMs).toISOString()}). ABORTING.`,
    )
  }

  state.phaseReached = 'proposed'
  saveState(state)
  return instr
}

// ── Phase 4: PAY (irreversible) ─────────────────────────────────────────────

async function phase4Pay(state: TrialState, instr: X402Instr): Promise<void> {
  hr()
  console.log('PHASE 4: PAY — sending USDC on Base Mainnet (IRREVERSIBLE)')

  if (process.env.DRY_RUN === '1') {
    console.log('\nDRY_RUN=1 — stopping before payment tx. Exiting cleanly.')
    process.exit(0)
  }

  // Build USDC.transfer(gateway, amountRaw)
  const amountRaw = BigInt(instr.amountUsdcRaw)
  const data = buildCallData(
    SELECTORS['transfer(address,uint256)'],
    encodeAddress(GATEWAY_ADDRESS),
    encodeUint256(amountRaw),
  )

  log('4', `Sending ${amountRaw} USDC-raw to gateway ${GATEWAY_ADDRESS}`)

  const txHash = await sendSignedTransaction({
    rpcCall,
    privateKey: state.buyer.privateKey,
    chainId: CHAIN_ID,
    to: USDC_ADDRESS,
    data,
    gasLimitFallback: 100_000n,
  })

  // PERSIST FIRST — before any further work
  state.paymentTxHash = txHash
  saveState(state)
  detail('Payment tx', txHash)
  detail('Basescan  ', `https://basescan.org/tx/${txHash}`)

  // Poll for receipt with exponential backoff (2s → 4s → 8s → 10s cap, 60s total)
  log('4', 'Polling for receipt (max 60s)...')
  const start = Date.now()
  let delay = 2_000
  let receipt: { status?: string } | null = null
  while (Date.now() - start < 60_000) {
    const r = await rpcCall('eth_getTransactionReceipt', [txHash]) as { status?: string } | null
    if (r) {
      receipt = r
      break
    }
    await new Promise(res => setTimeout(res, delay))
    delay = Math.min(delay * 2, 10_000)
  }

  if (!receipt) {
    throw new Error(
      `Receipt not found in 60s for ${txHash}. Do NOT retry x402-pay — ` +
      `investigate manually: https://basescan.org/tx/${txHash}`,
    )
  }
  if (receipt.status !== '0x1') {
    throw new Error(
      `Payment tx REVERTED (status=${receipt.status}): ${txHash}. ` +
      `Investigate: https://basescan.org/tx/${txHash}`,
    )
  }
  detail('Receipt status', receipt.status)

  // POST /x402-pay — single try, no blind retry
  log('4', `POST /v2/escrow/${state.escrowId}/x402-pay...`)
  const { status, data: payData, error: payErr } = await authedFetch<Record<string, unknown>>(
    'POST', `/v2/escrow/${state.escrowId}/x402-pay`, { txHash }, state.buyer,
  )
  if (status !== 200) {
    throw new Error(
      `x402-pay FAILED (status ${status}): ${JSON.stringify(payErr)}. ` +
      `Escrow ID: ${state.escrowId}. Payment tx: ${txHash}. ` +
      `Do NOT retry — inspect manually and contact support.`,
    )
  }

  detail('Escrow status', payData?.status as string)
  const macaroon = payData?.x402Macaroon as string | undefined
  if (macaroon) {
    detail('Macaroon (truncated)', macaroon.slice(0, 40) + '...')
  }

  state.phaseReached = 'paid'
  saveState(state)
}

// ── Phase 5: Accept, deliver, confirm, settle ──────────────────────────────

async function phase5Execute(state: TrialState): Promise<void> {
  hr()
  console.log('PHASE 5: ACCEPT → DELIVER → CONFIRM → SETTLE')

  // Seller accepts
  log('5', 'Seller accepting escrow...')
  const { status: accStatus, data: accData, error: accErr } = await authedFetch<Record<string, unknown>>(
    'POST', `/v2/escrow/${state.escrowId}/accept`, {}, state.seller,
  )
  if (accStatus !== 200) {
    throw new Error(`Accept failed (${accStatus}): ${JSON.stringify(accErr)}`)
  }
  detail('Escrow status', accData?.status as string)

  // Seller delivers
  log('5', 'Seller delivering...')
  const deliverable = {
    echo: 'trustthenverify-x402-live-trial',
    timestamp: new Date().toISOString(),
  }
  const { status: delStatus, error: delErr } = await authedFetch(
    'POST', `/v2/escrow/${state.escrowId}/deliver`, { deliverable }, state.seller,
  )
  if (delStatus !== 200) {
    throw new Error(`Deliver failed (${delStatus}): ${JSON.stringify(delErr)}`)
  }
  state.phaseReached = 'delivered'
  saveState(state)

  // Buyer confirms
  log('5', 'Buyer confirming delivery...')
  const { status: confStatus, data: confData, error: confErr } = await authedFetch<Record<string, unknown>>(
    'POST', `/v2/escrow/${state.escrowId}/confirm`, {}, state.buyer,
  )
  if (confStatus !== 200) {
    throw new Error(`Confirm failed (${confStatus}): ${JSON.stringify(confErr)}`)
  }
  detail('Confirm status', confData?.status as string)

  // Poll for settlement — up to 2 minutes, every 3s
  // API field (from packages/api/src/routes/escrow.ts:942) is x402_seller_payout_tx,
  // which snakeToCamel converts to x402SellerPayoutTx.
  log('5', 'Polling GET /v2/escrow/:id for released + settlement tx (max 120s)...')
  const startPoll = Date.now()
  let finalEscrow: Record<string, unknown> | undefined
  while (Date.now() - startPoll < 120_000) {
    const { status, data: escrowData } = await authedFetch<Record<string, unknown>>(
      'GET', `/v2/escrow/${state.escrowId}`, null, state.buyer,
    )
    if (status === 200 && escrowData) {
      finalEscrow = escrowData
      const s = escrowData.status as string
      const payoutTx = escrowData.x402SellerPayoutTx as string | null | undefined
      if (payoutTx && !state.settlementTxHash) {
        state.settlementTxHash = payoutTx
        saveState(state)
        detail('Settlement tx captured', payoutTx)
      }
      if (s === 'released') {
        detail('Escrow released', true)
        break
      }
    }
    await new Promise(res => setTimeout(res, 3_000))
  }

  if (!finalEscrow || (finalEscrow.status as string) !== 'released') {
    throw new Error(
      `Escrow did not reach 'released' within 120s. Last status: ${finalEscrow?.status}. ` +
      `Escrow ID: ${state.escrowId}. Settlement tx (if any): ${state.settlementTxHash}`,
    )
  }

  if (!state.settlementTxHash) {
    console.log('\n⚠️  WARNING: escrow released but no x402SellerPayoutTx in response. Settlement may have been deferred.')
  }

  state.phaseReached = 'released'
  saveState(state)
}

// ── Phase 6: On-chain verification ──────────────────────────────────────────

async function phase6Verify(state: TrialState): Promise<void> {
  hr()
  console.log('PHASE 6: ON-CHAIN VERIFICATION')

  await new Promise(res => setTimeout(res, 4_000))

  const sellerBal = await usdcBalanceOf(state.sellerEthAddress!)
  detail('Seller USDC after settlement', `${sellerBal.toString()} units (${Number(sellerBal) / 1e6} USDC)`)

  // Expected: ~990_000 units (1 USDC - 1% fee). Accept 980k-1000k.
  if (sellerBal < 980_000n || sellerBal > 1_000_000n) {
    console.log(`\n⚠️  Unexpected seller balance: ${sellerBal}. Expected 980000-1000000.`)
  } else {
    log('6', `Seller balance in expected range [980000, 1000000]`)
  }

  if (state.settlementTxHash) {
    const r = await rpcCall('eth_getTransactionReceipt', [state.settlementTxHash]) as { status?: string } | null
    if (r?.status === '0x1') {
      detail('Settlement receipt status', r.status)
    } else {
      console.log(`\n⚠️  Settlement tx receipt status: ${r?.status ?? 'not-mined'}`)
    }
    detail('Settlement basescan', `https://basescan.org/tx/${state.settlementTxHash}`)
  }
}

// ── Phase 7: Summary ────────────────────────────────────────────────────────

async function phase7Summary(state: TrialState): Promise<void> {
  hr()
  console.log('PHASE 7: SUMMARY')

  const [buyerUsdc, sellerUsdc, buyerEth, sellerEth] = await Promise.all([
    usdcBalanceOf(state.buyerEthAddress!),
    usdcBalanceOf(state.sellerEthAddress!),
    ethBalanceOf(state.buyerEthAddress!),
    ethBalanceOf(state.sellerEthAddress!),
  ])

  console.log('')
  console.log('  Trial complete — paper trail')
  console.log('  ' + '─'.repeat(60))
  console.log(`  Buyer address  : ${state.buyerEthAddress}`)
  console.log(`  Seller address : ${state.sellerEthAddress}`)
  console.log(`  Escrow ID      : ${state.escrowId}`)
  console.log(`  Payment tx     : ${state.paymentTxHash}`)
  console.log(`                   https://basescan.org/tx/${state.paymentTxHash}`)
  console.log(`  Settlement tx  : ${state.settlementTxHash ?? '(none captured)'}`)
  if (state.settlementTxHash) {
    console.log(`                   https://basescan.org/tx/${state.settlementTxHash}`)
  }
  console.log(`  Amount in      : 1000000 USDC-raw (1.00 USDC)`)
  console.log(`  Amount out     : ${sellerUsdc} USDC-raw (${Number(sellerUsdc) / 1e6} USDC)`)
  console.log(`  Fee            : ~10000 USDC-raw (0.01 USDC, 1%)`)
  console.log(`  Buyer residual : USDC=${buyerUsdc} ETH=${buyerEth}`)
  console.log(`  Seller residual: USDC=${sellerUsdc} ETH=${sellerEth}`)
}

// ── Phase 7.5: Sweep-back ───────────────────────────────────────────────────

async function phase75Sweep(state: TrialState): Promise<void> {
  hr()
  console.log('PHASE 7.5: SWEEP-BACK (optional)')

  const sweepAddr = await pause(
    'Enter a Base-Mainnet Ethereum address to sweep residual USDC+ETH back to (or blank to skip):',
  )

  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(sweepAddr)
  if (!sweepAddr) {
    const [buyerUsdc, sellerUsdc] = await Promise.all([
      usdcBalanceOf(state.buyerEthAddress!),
      usdcBalanceOf(state.sellerEthAddress!),
    ])
    console.log(`  No sweep address provided.`)
    console.log(`  Residual on buyer  (${state.buyerEthAddress}): ${buyerUsdc} USDC-raw`)
    console.log(`  Residual on seller (${state.sellerEthAddress}): ${sellerUsdc} USDC-raw`)
    console.log(`  Throwaway keys remain in ${STATE_FILE}`)
    state.phaseReached = 'swept'
    saveState(state)
    return
  }

  if (!isAddr) {
    console.log(`  "${sweepAddr}" doesn't look like a valid Ethereum address. Skipping sweep.`)
    state.phaseReached = 'swept'
    saveState(state)
    return
  }

  // Sweep buyer USDC
  const buyerUsdc = await usdcBalanceOf(state.buyerEthAddress!)
  if (buyerUsdc > 100n) {
    log('7.5', `Sweeping ${buyerUsdc} USDC-raw from buyer → ${sweepAddr}`)
    const data = buildCallData(
      SELECTORS['transfer(address,uint256)'],
      encodeAddress(sweepAddr),
      encodeUint256(buyerUsdc),
    )
    const tx = await sendSignedTransaction({
      rpcCall,
      privateKey: state.buyer.privateKey,
      chainId: CHAIN_ID,
      to: USDC_ADDRESS,
      data,
      gasLimitFallback: 100_000n,
    })
    detail('Buyer USDC sweep tx', `https://basescan.org/tx/${tx}`)
  } else {
    detail('Buyer USDC', `${buyerUsdc} — nothing to sweep`)
  }

  // Sweep seller USDC
  const sellerUsdc = await usdcBalanceOf(state.sellerEthAddress!)
  if (sellerUsdc > 100n) {
    log('7.5', `Sweeping ${sellerUsdc} USDC-raw from seller → ${sweepAddr}`)
    const data = buildCallData(
      SELECTORS['transfer(address,uint256)'],
      encodeAddress(sweepAddr),
      encodeUint256(sellerUsdc),
    )
    const tx = await sendSignedTransaction({
      rpcCall,
      privateKey: state.seller.privateKey,
      chainId: CHAIN_ID,
      to: USDC_ADDRESS,
      data,
      gasLimitFallback: 100_000n,
    })
    detail('Seller USDC sweep tx', `https://basescan.org/tx/${tx}`)
  } else {
    detail('Seller USDC', `${sellerUsdc} — nothing to sweep`)
  }

  // ETH sweep: SKIPPED intentionally. sendSignedTransaction in api/src/lib/eth-utils.ts
  // hardcodes value=0 (line 85), so it can only send data txs, not bare ETH transfers.
  // Residual ETH (~0.0002 ETH ≈ $0.60) is small enough that adding a separate RLP
  // helper here isn't worth the surface area for correctness-critical money code.
  // Print what's left so the user can decide whether to manually sweep.
  const [buyerEth, sellerEth] = await Promise.all([
    ethBalanceOf(state.buyerEthAddress!),
    ethBalanceOf(state.sellerEthAddress!),
  ])
  console.log('')
  console.log('  ETH sweep SKIPPED (sendSignedTransaction hardcodes value=0).')
  console.log(`  Residual ETH on buyer  (${state.buyerEthAddress}): ${buyerEth} wei (${Number(buyerEth) / 1e18} ETH)`)
  console.log(`  Residual ETH on seller (${state.sellerEthAddress}): ${sellerEth} wei (${Number(sellerEth) / 1e18} ETH)`)
  console.log(`  Private keys persist in ${STATE_FILE} if you want to sweep manually later.`)

  state.phaseReached = 'swept'
  saveState(state)
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═'.repeat(72))
  console.log('TrustThenVerify — x402 Live E2E Commerce Trial')
  console.log('Base Mainnet, REAL USDC | Budget: ~$1.50')
  console.log(`Date: ${new Date().toISOString().split('T')[0]}`)
  console.log('═'.repeat(72))

  const state = await phase1Setup()
  await phase2Preflight(state)
  const instr = await phase3Propose(state)
  await phase4Pay(state, instr)
  await phase5Execute(state)
  await phase6Verify(state)
  await phase7Summary(state)
  await phase75Sweep(state)

  hr()
  console.log('TRIAL COMPLETE.')
}

main().catch((err) => {
  console.error('\nFATAL ERROR:', err)
  process.exit(1)
})
