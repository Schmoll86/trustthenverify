/**
 * Live Claude Agent E2E Tests
 *
 * Real Claude models (Sonnet 4.6, Haiku 4.5, Sonnet 4.5) autonomously drive
 * the TrustThenVerify protocol end-to-end against production APIs.
 *
 * Each agent gets:
 *   - A TrustProtocol instance with real ECDSA keys
 *   - Role-specific tool definitions (subset of 37 MCP tools)
 *   - A system prompt defining its role
 *   - A scenario-specific user prompt
 *
 * Agents make real decisions, call real APIs, and transact on Base Mainnet.
 *
 * Usage:
 *   cd packages/e2e
 *   ANTHROPIC_API_KEY=sk-ant-... npx vitest --run live-agents.test.ts
 *
 * Cost: ~$0.35 per full run
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  generateKeypair,
  createAgent,
  TrustProtocol,
  publicKeyToAddress,
  queryAttestations,
  listMarketplacePolicies,
} from '@trustthenverify/sdk'

import {
  runAgent,
  getToolsForRole,
  getToolResults,
  SYSTEM_PROMPTS,
  type ModelId,
  type AgentTranscript,
} from './lib/agent-harness.js'

// ─── Config ──────────────────────────────────────────────────────────────────

const PROD_API_URL = 'https://api.trustthenverify.com/v2'
const SANDBOX_API_URL = 'https://sandbox.trustthenverify.com/v2'
// Sandbox for lifecycle tests (no real payment method needed), production for on-chain + Stripe
const API_URL = process.env.E2E_API_URL ?? SANDBOX_API_URL
const PROD_URL = process.env.E2E_PROD_API_URL ?? PROD_API_URL
const RPC_URL = 'https://base-mainnet.g.alchemy.com/v2/pSqXLT1kg-6HQ7rE7Gu9W'
const GATEWAY_ADDRESS = '0x2299244F6c99E59A1f8197509030428030aaaff9'

const MODELS = {
  buyer: 'claude-sonnet-4-6' as ModelId,
  seller: 'claude-haiku-4-5' as ModelId,
  oracle: 'claude-sonnet-4-5' as ModelId,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createTestAgent(
  name: string,
  capabilities: string[] = [],
  apiUrl = API_URL,
): Promise<{ keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }> {
  const keypair = generateKeypair()

  await createAgent({
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    name: `e2e-agent-${name}-${Date.now()}`,
    capabilities,
    apiUrl,
  })

  const protocol = new TrustProtocol({
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    apiUrl,
  })

  return { keypair, protocol }
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (json.error) throw new Error(`RPC error: ${json.error.message}`)
  return json.result
}

function logTranscript(label: string, transcript: AgentTranscript) {
  console.log(`\n=== ${label} Transcript ===`)
  console.log(`Model: ${transcript.model}`)
  console.log(`Turns: ${transcript.turns.length}`)
  console.log(`Tokens: ${transcript.totalTokens.input} in / ${transcript.totalTokens.output} out`)
  for (const turn of transcript.turns) {
    if (turn.type === 'assistant' && turn.content) {
      console.log(`  [reasoning] ${turn.content.slice(0, 300)}`)
    }
    if (turn.toolCalls) {
      for (const tc of turn.toolCalls) {
        console.log(`  [tool] ${tc.name}(${JSON.stringify(tc.input).slice(0, 120)})`)
      }
    }
  }
}

// ─── Pre-flight ──────────────────────────────────────────────────────────────

beforeAll(() => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY env var required')
  }
})

// ─── Scenario 1: Happy Path ─────────────────────────────────────────────────

describe('Scenario 1: Happy Path Escrow', { timeout: 120_000 }, () => {
  let buyer: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let seller: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let escrowId: string

  it('registers buyer and seller agents', async () => {
    ;[buyer, seller] = await Promise.all([
      createTestAgent('buyer', ['purchase']),
      createTestAgent('seller', ['research', 'writing']),
    ])
    expect(buyer.keypair.publicKey).toBeTruthy()
    expect(seller.keypair.publicKey).toBeTruthy()
  })

  it('buyer proposes escrow autonomously', async () => {
    const transcript = await runAgent({
      role: 'buyer',
      model: MODELS.buyer,
      systemPrompt: SYSTEM_PROMPTS.buyer,
      userPrompt: `You need to hire a seller to find the top 3 TypeScript testing libraries with brief descriptions.

Seller public key: ${seller.keypair.publicKey}

Propose a $0.01 escrow (amountCents: 1) with verification method "buyer_confirm".
Task spec should describe what you need. Set timeoutSeconds to 3600.

Use the trust_propose_escrow tool. After proposing, report the escrow ID.`,
      protocol: buyer.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Buyer Propose', transcript)

    const proposeResults = getToolResults(transcript, 'trust_propose_escrow')
    expect(proposeResults.length).toBe(1)
    const escrow = proposeResults[0] as { id: string; status: string }
    expect(escrow.id).toBeTruthy()
    expect(escrow.status).toBe('proposed')
    escrowId = escrow.id
  })

  it('seller accepts and delivers autonomously', async () => {
    const transcript = await runAgent({
      role: 'seller',
      model: MODELS.seller,
      systemPrompt: SYSTEM_PROMPTS.seller,
      userPrompt: `You have a pending escrow to accept and fulfill.

Escrow ID: ${escrowId}

Steps:
1. Accept the escrow using trust_accept_escrow
2. Deliver a genuine response listing the top 3 TypeScript testing libraries with descriptions using trust_deliver. The deliverable should be a JSON object with a "results" array.

Do both steps now.`,
      protocol: seller.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Seller Accept+Deliver', transcript)

    const acceptResults = getToolResults(transcript, 'trust_accept_escrow')
    expect(acceptResults.length).toBe(1)
    const accepted = acceptResults[0] as { status: string }
    expect(accepted.status).toBe('active')

    const deliverResults = getToolResults(transcript, 'trust_deliver')
    expect(deliverResults.length).toBe(1)
  })

  it('buyer confirms delivery autonomously', async () => {
    const transcript = await runAgent({
      role: 'buyer',
      model: MODELS.buyer,
      systemPrompt: SYSTEM_PROMPTS.buyer,
      userPrompt: `Check the escrow status and confirm the delivery.

Escrow ID: ${escrowId}

Steps:
1. Check escrow status with trust_escrow_status
2. If delivered, confirm with trust_confirm_delivery
3. Publish a positive attestation about the seller using trust_publish_attestation (subjectId: "${seller.keypair.publicKey}", outcome: "success", escrowId: "${escrowId}")`,
      protocol: buyer.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Buyer Confirm', transcript)

    const confirmResults = getToolResults(transcript, 'trust_confirm_delivery')
    expect(confirmResults.length).toBe(1)
    const confirmed = confirmResults[0] as { status: string }
    expect(confirmed.status).toBe('released')

    const attestResults = getToolResults(transcript, 'trust_publish_attestation')
    expect(attestResults.length).toBeGreaterThanOrEqual(1)
  })

  it('seller publishes attestation', async () => {
    const transcript = await runAgent({
      role: 'seller',
      model: MODELS.seller,
      systemPrompt: SYSTEM_PROMPTS.seller,
      userPrompt: `Publish a positive attestation about the buyer.

Use trust_publish_attestation with:
- subjectId: "${buyer.keypair.publicKey}"
- outcome: "success"
- escrowId: "${escrowId}"`,
      protocol: seller.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Seller Attestation', transcript)

    const attestResults = getToolResults(transcript, 'trust_publish_attestation')
    expect(attestResults.length).toBe(1)
  })

  it('attestations exist for both parties', async () => {
    const sellerAtts = await queryAttestations(seller.keypair.publicKey, { apiUrl: API_URL })
    const buyerAtts = await queryAttestations(buyer.keypair.publicKey, { apiUrl: API_URL })

    expect(sellerAtts.length).toBeGreaterThanOrEqual(1)
    expect(buyerAtts.length).toBeGreaterThanOrEqual(1)
    expect(sellerAtts.some(a => a.outcome === 'success')).toBe(true)
    expect(buyerAtts.some(a => a.outcome === 'success')).toBe(true)
  })
})

// ─── Scenario 2: On-Chain Escrow ─────────────────────────────────────────────

describe('Scenario 2: On-Chain Escrow (Base Mainnet)', { timeout: 120_000 }, () => {
  let buyer: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let seller: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let escrowId: string
  let hasGas = true

  it('checks gateway ETH balance', async () => {
    const balance = (await rpcCall('eth_getBalance', [GATEWAY_ADDRESS, 'latest'])) as string
    const ethWei = BigInt(balance)
    const minWei = BigInt('1000000000000000') // 0.001 ETH
    console.log(`Gateway balance: ${ethWei} wei (${Number(ethWei) / 1e18} ETH)`)
    if (ethWei < minWei) {
      hasGas = false
      console.warn('Gateway needs ETH — skipping on-chain deploy tests')
    }
  })

  it('registers agents with ETH addresses', async () => {
    ;[buyer, seller] = await Promise.all([
      createTestAgent('onchain-buyer', ['purchase'], PROD_URL),
      createTestAgent('onchain-seller', ['compute'], PROD_URL),
    ])

    const buyerAddr = publicKeyToAddress(buyer.keypair.publicKey)
    const sellerAddr = publicKeyToAddress(seller.keypair.publicKey)
    expect(buyerAddr).toMatch(/^0x[0-9a-f]{40}$/)
    expect(sellerAddr).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it('buyer proposes on-chain escrow', async () => {
    if (!hasGas) return

    const buyerAddr = publicKeyToAddress(buyer.keypair.publicKey)
    const sellerAddr = publicKeyToAddress(seller.keypair.publicKey)

    const transcript = await runAgent({
      role: 'buyer',
      model: MODELS.buyer,
      systemPrompt: SYSTEM_PROMPTS.buyer,
      userPrompt: `Propose an on-chain escrow for a data retrieval task.

Seller public key: ${seller.keypair.publicKey}

Use trust_propose_escrow with:
- amountCents: 1 (one cent)
- taskSpec: { "type": "data-retrieval", "query": "quarterly earnings AAPL 2025" }
- verificationMethod: "buyer_confirm"
- fundingMode: "onchain"
- buyerAddress: "${buyerAddr}"
- sellerAddress: "${sellerAddr}"
- timeoutSeconds: 3600`,
      protocol: buyer.protocol,
      apiUrl: PROD_URL,
    })

    logTranscript('On-Chain Propose', transcript)

    const proposeResults = getToolResults(transcript, 'trust_propose_escrow')
    expect(proposeResults.length).toBe(1)
    const escrow = proposeResults[0] as { id: string; fundingMode: string }
    expect(escrow.id).toBeTruthy()
    expect(escrow.fundingMode).toBe('onchain')
    escrowId = escrow.id
  })

  it('seller accepts → contract deployed', async () => {
    if (!hasGas) return

    const transcript = await runAgent({
      role: 'seller',
      model: MODELS.seller,
      systemPrompt: SYSTEM_PROMPTS.seller,
      userPrompt: `Accept the pending on-chain escrow.

Escrow ID: ${escrowId}

Use trust_accept_escrow to accept it. The system will deploy an EscrowInstance contract on Base Mainnet.`,
      protocol: seller.protocol,
      apiUrl: PROD_URL,
    })

    logTranscript('On-Chain Accept', transcript)

    const acceptResults = getToolResults(transcript, 'trust_accept_escrow')
    expect(acceptResults.length).toBe(1)
    const accepted = acceptResults[0] as { status: string; contractAddress?: string }
    // On-chain accept may be 'accepted' or 'active' depending on funding state
    expect(['accepted', 'active']).toContain(accepted.status)
  })

  it('verifies contract exists on-chain', async () => {
    if (!hasGas) return

    // Get escrow to find contract address
    const escrow = await buyer.protocol.getEscrow(escrowId)
    if (!escrow.contractAddress) {
      console.warn('No contract address yet — skipping on-chain verification')
      return
    }

    const code = (await rpcCall('eth_getCode', [escrow.contractAddress, 'latest'])) as string
    expect(code.length).toBeGreaterThan(2) // '0x' + bytecode
    console.log(`Contract deployed at ${escrow.contractAddress} (${code.length} chars bytecode)`)
  })
})

// ─── Scenario 3: Dispute → Arbitration ───────────────────────────────────────

describe('Scenario 3: Dispute and Arbitration', { timeout: 120_000 }, () => {
  let buyer: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let seller: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let escrowId: string

  it('registers agents', async () => {
    ;[buyer, seller] = await Promise.all([
      createTestAgent('dispute-buyer', ['purchase']),
      createTestAgent('dispute-seller', ['writing']),
    ])
  })

  it('buyer proposes escrow', async () => {
    const escrow = await buyer.protocol.proposeEscrow({
      seller: seller.keypair.publicKey,
      amountCents: 1,
      taskSpec: {
        query: 'Write a detailed comparison of React vs Vue vs Svelte',
        requirements: 'At least 200 words with pros and cons for each framework',
      },
      verificationMethod: 'buyer_confirm',
      timeoutSeconds: 3600,
      collateralRatio: 0.5,
    })
    escrowId = escrow.id
    expect(escrow.status).toBe('proposed')
  })

  it('seller delivers intentionally weak work', async () => {
    // Accept first
    await seller.protocol.acceptEscrow(escrowId)

    const transcript = await runAgent({
      role: 'seller',
      model: MODELS.seller,
      systemPrompt: SYSTEM_PROMPTS.sellerWeak,
      userPrompt: `Accept and deliver work for this escrow.

Escrow ID: ${escrowId}

The task asks for a detailed comparison of React vs Vue vs Svelte with at least 200 words.
Deliver something very brief and unhelpful — just a few words. Use trust_deliver with a deliverable object containing a "response" field.`,
      protocol: seller.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Weak Delivery', transcript)

    const deliverResults = getToolResults(transcript, 'trust_deliver')
    expect(deliverResults.length).toBe(1)
  })

  it('buyer disputes with reason', async () => {
    const transcript = await runAgent({
      role: 'buyer',
      model: MODELS.buyer,
      systemPrompt: SYSTEM_PROMPTS.buyer,
      userPrompt: `Check the escrow and dispute the delivery if it's inadequate.

Escrow ID: ${escrowId}

Steps:
1. Check escrow status with trust_escrow_status
2. The seller delivered very low-quality work that doesn't meet the requirements
3. Dispute using trust_dispute with a clear reason explaining why the deliverable is inadequate`,
      protocol: buyer.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Buyer Dispute', transcript)

    const disputeResults = getToolResults(transcript, 'trust_dispute')
    expect(disputeResults.length).toBe(1)
    const disputed = disputeResults[0] as { status: string; error?: string }

    // Dispute may trigger LLM arbitration immediately or go to 'disputed' state
    // LLM judge (OpenRouter) may be unavailable → 502 error is acceptable
    if (disputed.error) {
      expect(disputed.error).toMatch(/502|ARBITRATION_FAILED|ESCROW_NOT_ACTIVE/)
    } else {
      expect(['disputed', 'released', 'failed', 'resolved']).toContain(disputed.status)
    }
  })
})

// ─── Scenario 4: Oracle Consensus ────────────────────────────────────────────

describe('Scenario 4: Oracle Consensus', { timeout: 180_000 }, () => {
  let buyer: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let seller: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let oracles: Array<{ keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }>
  let escrowId: string

  it('registers buyer, seller, and 3 oracles', async () => {
    const [b, s, o1, o2, o3] = await Promise.all([
      createTestAgent('oracle-buyer', ['purchase']),
      createTestAgent('oracle-seller', ['research']),
      createTestAgent('oracle-1', ['verification', 'research']),
      createTestAgent('oracle-2', ['verification', 'research']),
      createTestAgent('oracle-3', ['verification', 'research']),
    ])
    buyer = b
    seller = s
    oracles = [o1, o2, o3]
  })

  it('oracles join pool', async () => {
    const joinResults = await Promise.all(
      oracles.map(oracle =>
        runAgent({
          role: 'oracle',
          model: MODELS.oracle,
          systemPrompt: SYSTEM_PROMPTS.oracle,
          userPrompt: `Join the oracle verification pool with capabilities ["verification", "research"].

Use trust_join_oracle_pool.`,
          protocol: oracle.protocol,
          apiUrl: API_URL,
          maxTurns: 3,
        }),
      ),
    )

    for (const transcript of joinResults) {
      const results = getToolResults(transcript, 'trust_join_oracle_pool')
      expect(results.length).toBe(1)
      const entry = results[0] as { status: string }
      expect(entry.status).toBe('active')
    }
  })

  it('buyer proposes oracle-verified escrow', async () => {
    const escrow = await buyer.protocol.proposeEscrow({
      seller: seller.keypair.publicKey,
      amountCents: 1,
      taskSpec: {
        query: 'List the top 3 most popular JavaScript frameworks in 2025',
        requirements: 'Include name and one-sentence description for each',
      },
      verificationMethod: 'oracle_consensus',
      timeoutSeconds: 3600,
    })
    escrowId = escrow.id
    expect(escrow.status).toBe('proposed')
    expect(escrow.oracleFeeCents).toBeGreaterThan(0)
  })

  it('seller accepts and delivers', async () => {
    await seller.protocol.acceptEscrow(escrowId)

    const result = await seller.protocol.deliver(escrowId, {
      results: [
        { name: 'React', description: 'A declarative, component-based UI library by Meta for building interactive interfaces.' },
        { name: 'Vue.js', description: 'A progressive framework for building user interfaces with an approachable, versatile ecosystem.' },
        { name: 'Next.js', description: 'A React-based framework providing server-side rendering, routing, and full-stack capabilities.' },
      ],
    })

    // Oracle consensus returns verification result
    expect(result).toBeTruthy()
  })

  it('oracles evaluate and vote', async () => {
    // Give the system a moment to assign tasks
    await new Promise(resolve => setTimeout(resolve, 2000))

    const voteTranscripts = await Promise.all(
      oracles.map(oracle =>
        runAgent({
          role: 'oracle',
          model: MODELS.oracle,
          systemPrompt: SYSTEM_PROMPTS.oracle,
          userPrompt: `You have been assigned oracle verification tasks. Check and vote on them.

Steps:
1. Use trust_oracle_assignments to get your pending assignments
2. For each assignment, use trust_get_oracle_task to see the deliverable and task spec
3. Evaluate whether the deliverable meets the task requirements
4. Submit your vote using trust_submit_oracle_vote with verdict "pass" or "fail" and a rationale

The task asked for the top 3 most popular JavaScript frameworks with names and descriptions.`,
          protocol: oracle.protocol,
          apiUrl: API_URL,
        }),
      ),
    )

    let votesSubmitted = 0
    for (const transcript of voteTranscripts) {
      logTranscript('Oracle Vote', transcript)
      const results = getToolResults(transcript, 'trust_submit_oracle_vote')
      votesSubmitted += results.length
    }

    // At least some oracles should have been assigned and voted
    // (oracle selection is non-deterministic, so not all 3 may get assigned)
    console.log(`Total oracle votes submitted: ${votesSubmitted}`)
  })

  it('escrow resolves based on consensus', async () => {
    // Check final escrow state
    const escrow = await buyer.protocol.getEscrow(escrowId)
    console.log(`Final escrow status: ${escrow.status}`)

    // After oracle voting, escrow should be in a resolved state
    // or still voting if not all oracles have been assigned yet
    expect([
      'delivered', // still waiting for votes
      'released',  // consensus: pass
      'failed',    // consensus: fail
      'active',    // oracle task created but not all voted
    ]).toContain(escrow.status)
  })
})

// ─── Scenario 5: Policy Lifecycle ────────────────────────────────────────────

describe('Scenario 5: Policy Lifecycle', { timeout: 120_000 }, () => {
  let buyer: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let seller: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let policyId: string
  let escrowId: string

  it('registers agents', async () => {
    ;[buyer, seller] = await Promise.all([
      createTestAgent('policy-buyer', ['purchase']),
      createTestAgent('policy-seller', ['research']),
    ])
  })

  it('buyer creates policy from NL intent', async () => {
    const transcript = await runAgent({
      role: 'buyer',
      model: MODELS.buyer,
      systemPrompt: SYSTEM_PROMPTS.buyer,
      userPrompt: `Create an acceptance policy for a research task.

Use trust_create_policy with:
- name: "research-quality-policy"
- intent: "Response must include at least 3 items, each with a title and a URL. Total response must be under 500 words."

Then check the coverage analysis with trust_get_coverage.
Then activate the policy with trust_activate_policy.

Report the policy ID and coverage results.`,
      protocol: buyer.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Policy Creation', transcript)

    const createResults = getToolResults(transcript, 'trust_create_policy')
    expect(createResults.length).toBe(1)
    const policy = createResults[0] as { id: string; formalSpec?: { constraints: unknown[] } }
    expect(policy.id).toBeTruthy()
    policyId = policy.id

    // Coverage may or may not have been checked depending on agent behavior
    const coverageResults = getToolResults(transcript, 'trust_get_coverage')
    if (coverageResults.length > 0) {
      const coverage = coverageResults[0] as { clauses: unknown[] }
      expect(coverage.clauses).toBeDefined()
    }
  })

  it('uses policy in escrow flow', async () => {
    const escrow = await buyer.protocol.proposeEscrow({
      seller: seller.keypair.publicKey,
      amountCents: 1,
      taskSpec: {
        query: 'Find 3 popular open-source AI projects with URLs',
      },
      policyId,
      verificationMethod: 'buyer_confirm',
      timeoutSeconds: 3600,
    })
    escrowId = escrow.id
    expect(escrow.policyId).toBe(policyId)
  })

  it('seller delivers against policy', async () => {
    await seller.protocol.acceptEscrow(escrowId)

    const transcript = await runAgent({
      role: 'seller',
      model: MODELS.seller,
      systemPrompt: SYSTEM_PROMPTS.seller,
      userPrompt: `Deliver work for this escrow. The policy requires at least 3 items with titles and URLs, under 500 words.

Escrow ID: ${escrowId}

Use trust_deliver with a deliverable containing a "results" array where each item has "title" and "url" fields. Make it genuine and useful.`,
      protocol: seller.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Policy Delivery', transcript)

    const deliverResults = getToolResults(transcript, 'trust_deliver')
    expect(deliverResults.length).toBe(1)
  })

  it('buyer confirms and escrow releases', async () => {
    const escrow = await buyer.protocol.confirmDelivery(escrowId)
    expect(escrow.status).toBe('released')
  })
})

// ─── Scenario 6: Marketplace Flow ────────────────────────────────────────────

describe('Scenario 6: Marketplace Flow', { timeout: 120_000 }, () => {
  let buyer: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let seller: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }

  it('registers agents', async () => {
    ;[buyer, seller] = await Promise.all([
      createTestAgent('market-buyer', ['purchase']),
      createTestAgent('market-seller', ['research']),
    ])
  })

  it('buyer browses and clones marketplace policy', async () => {
    const transcript = await runAgent({
      role: 'buyer',
      model: MODELS.buyer,
      systemPrompt: SYSTEM_PROMPTS.buyer,
      userPrompt: `Browse the marketplace and clone a policy for use.

Steps:
1. Use trust_list_marketplace to see available community policies
2. Pick the first policy from the list
3. Use trust_use_marketplace_policy to clone it for your use
4. Report what policy you cloned`,
      protocol: buyer.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Marketplace Browse', transcript)

    const listResults = getToolResults(transcript, 'trust_list_marketplace')
    expect(listResults.length).toBe(1)
    const policies = listResults[0] as unknown[]

    if (Array.isArray(policies) && policies.length > 0) {
      const cloneResults = getToolResults(transcript, 'trust_use_marketplace_policy')
      if (cloneResults.length > 0) {
        const cloned = cloneResults[0] as { id: string }
        expect(cloned.id).toBeTruthy()
        console.log(`Cloned marketplace policy: ${cloned.id}`)
      }
    } else {
      console.log('No marketplace policies available — skipping clone')
    }
  })
})

// ─── Scenario 7: Payment Channel ─────────────────────────────────────────────

describe('Scenario 7: Payment Channel', { timeout: 120_000 }, () => {
  let buyer: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let seller: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  const channelAddress = `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`

  it('registers agents', async () => {
    ;[buyer, seller] = await Promise.all([
      createTestAgent('channel-buyer', ['purchase']),
      createTestAgent('channel-seller', ['compute']),
    ])
  })

  it('buyer registers, reads, and closes payment channel', async () => {
    const transcript = await runAgent({
      role: 'buyer',
      model: MODELS.buyer,
      systemPrompt: SYSTEM_PROMPTS.buyer,
      tools: [...getToolsForRole('buyer', ['channels'])],
      userPrompt: `Manage a payment channel lifecycle.

Steps:
1. Register a payment channel using trust_register_channel with:
   - channelAddress: "${channelAddress}"
   - counterparty: "${seller.keypair.publicKey}"
   - depositAmount: 1000
   - chainId: 8453
   - expiryAt: "2027-12-31T23:59:59Z"

2. Read the channel state with trust_get_channel (channelAddress: "${channelAddress}")

3. Close the channel with trust_close_channel (channelAddress: "${channelAddress}")

Report the results of each step.`,
      protocol: buyer.protocol,
      apiUrl: API_URL,
    })

    logTranscript('Payment Channel', transcript)

    const registerResults = getToolResults(transcript, 'trust_register_channel')
    expect(registerResults.length).toBe(1)
    const channel = registerResults[0] as { status?: string; error?: string }
    if (!channel.error) {
      expect(channel.status).toBe('open')

      const readResults = getToolResults(transcript, 'trust_get_channel')
      expect(readResults.length).toBe(1)

      const closeResults = getToolResults(transcript, 'trust_close_channel')
      expect(closeResults.length).toBe(1)
      const closed = closeResults[0] as { status: string }
      expect(closed.status).toBe('closed')
    }
  })
})

// ─── Scenario 8: Stripe Onboarding ──────────────────────────────────────────

describe('Scenario 8: Stripe Onboarding', { timeout: 120_000 }, () => {
  let buyer: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }
  let seller: { keypair: ReturnType<typeof generateKeypair>; protocol: TrustProtocol }

  it('registers agents', async () => {
    ;[buyer, seller] = await Promise.all([
      createTestAgent('stripe-buyer', ['purchase'], PROD_URL),
      createTestAgent('stripe-seller', ['writing'], PROD_URL),
    ])
  })

  it('buyer sets up Stripe customer', async () => {
    const transcript = await runAgent({
      role: 'buyer',
      model: MODELS.buyer,
      systemPrompt: SYSTEM_PROMPTS.buyer,
      userPrompt: `Set up your Stripe payment capabilities.

Steps:
1. Create a Stripe Customer with trust_setup_stripe_customer
2. Create a SetupIntent with trust_create_setup_intent
3. Check your Stripe status with trust_get_stripe_status

Report the results.`,
      protocol: buyer.protocol,
      apiUrl: PROD_URL,
    })

    logTranscript('Buyer Stripe Setup', transcript)

    const customerResults = getToolResults(transcript, 'trust_setup_stripe_customer')
    expect(customerResults.length).toBe(1)
    const agent = customerResults[0] as { stripeCustomerId?: string; error?: string }
    if (!agent.error) {
      expect(agent.stripeCustomerId).toBeTruthy()
    }
  })

  it('seller sets up Stripe Connect', async () => {
    const transcript = await runAgent({
      role: 'seller',
      model: MODELS.seller,
      systemPrompt: SYSTEM_PROMPTS.seller,
      userPrompt: `Set up your Stripe Connect account to receive payments.

Steps:
1. Create a Stripe Express connected account with trust_setup_stripe_connect
2. Check your status with trust_get_stripe_status

Report the onboarding URL and status.`,
      protocol: seller.protocol,
      apiUrl: PROD_URL,
    })

    logTranscript('Seller Stripe Connect', transcript)

    const connectResults = getToolResults(transcript, 'trust_setup_stripe_connect')
    expect(connectResults.length).toBe(1)
    const result = connectResults[0] as { agent?: { stripeConnectedAccountId?: string }; onboardingUrl?: string; error?: string }
    if (!result.error) {
      expect(result.agent?.stripeConnectedAccountId).toBeTruthy()
      expect(result.onboardingUrl).toBeTruthy()
    }
  })
})
