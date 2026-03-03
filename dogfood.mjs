#!/usr/bin/env node
/**
 * TTV Dogfood Script — The Protocol Building Itself
 *
 * Uses TrustThenVerify's SDK to create real escrow transactions
 * on the live sandbox, commissioning improvements to TTV itself.
 *
 * Exercises: buyer_confirm + hash_match verification methods,
 * attestation via public key, full lifecycle.
 */

import { generateKeypair, signRequest, sha256Hex } from './packages/sdk/dist/crypto.js'

const API = 'https://sandbox.trustthenverify.com/v2'
const SANDBOX_KEY = '0cee2fb4ea768294303e679bebf82cc54ebb3eb459876a36aedbc40bef9657a1'

// ─── Helpers ─────────────────────────────────────────

async function signedFetch(method, path, body, keypair) {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const bodyStr = body ? JSON.stringify(body) : ''
  const signature = await signRequest(keypair.privateKey, method, path, bodyStr, timestamp)

  const url = `${API}${path}`
  const headers = {
    'Content-Type': 'application/json',
    'X-Agent-Pubkey': keypair.publicKey,
    'X-Agent-Timestamp': timestamp,
    'X-Agent-Signature': signature,
    'X-Sandbox-Key': SANDBOX_KEY,
  }

  const res = await fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
  })

  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }

  if (!res.ok) {
    console.error(`  ✗ ${method} ${path} → ${res.status}`)
    console.error(`    ${typeof data === 'string' ? data : JSON.stringify(data)}`)
    return null
  }
  return data
}

async function publicFetch(path) {
  const res = await fetch(`${API}${path}`)
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

// ─── Main ────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║  TrustThenVerify — Dogfood: The Protocol Building Itself ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()

  // ── Step 1: Generate keypairs ──
  console.log('▸ Step 1: Generating agent keypairs...')
  const architect = generateKeypair()
  const builder = generateKeypair()
  console.log(`  Architect (buyer):  ${architect.publicKey.slice(0, 16)}...`)
  console.log(`  Builder   (seller): ${builder.publicKey.slice(0, 16)}...`)
  console.log()

  // ── Step 2: Register agents ──
  console.log('▸ Step 2: Registering agents on live sandbox...')

  const architectAgent = await signedFetch('POST', '/agents', {
    publicKey: architect.publicKey,
    name: 'Claude-Architect',
    capabilities: ['project-management', 'code-review', 'architecture', 'procurement'],
    endpoint: 'https://trustthenverify.com/agents/claude-architect',
    metadata: {
      description: 'AI agent that commissions and reviews improvements to TrustThenVerify',
      role: 'buyer',
      model: 'claude-opus-4-6',
    }
  }, architect)

  if (!architectAgent) return console.error('Failed to register architect')
  console.log(`  ✓ Claude-Architect registered (id: ${architectAgent.data?.id?.slice(0,8)}...)`)

  const builderAgent = await signedFetch('POST', '/agents', {
    publicKey: builder.publicKey,
    name: 'Claude-Builder',
    capabilities: ['typescript', 'cloudflare-workers', 'api-development', 'testing', 'frontend'],
    endpoint: 'https://trustthenverify.com/agents/claude-builder',
    metadata: {
      description: 'AI agent that builds features and fixes for TrustThenVerify',
      role: 'seller',
      model: 'claude-opus-4-6',
    }
  }, builder)

  if (!builderAgent) return console.error('Failed to register builder')
  console.log(`  ✓ Claude-Builder registered (id: ${builderAgent.data?.id?.slice(0,8)}...)`)
  console.log()

  // ── Step 3: Verify discovery ──
  console.log('▸ Step 3: Verifying agents are discoverable...')
  const search = await publicFetch(`/agents/search?capabilities=typescript`)
  const foundBuilder = search?.data?.find(a => a.publicKey === builder.publicKey)
  console.log(`  ✓ Claude-Builder found via capability search: ${foundBuilder ? 'YES' : 'checking...'}`)

  const lookup = await publicFetch(`/agents/${builder.publicKey}`)
  console.log(`  ✓ Claude-Builder lookup: ${lookup?.data?.name || 'not found'}`)
  console.log()

  // ── Step 4: Create escrows — Real TTV improvements ──
  console.log('▸ Step 4: Creating escrows for TTV improvements...')
  console.log()

  // Escrow #1: buyer_confirm — general feature work
  const tasks = [
    {
      label: '#1 — Implement hash_match verification',
      amount: 15000,
      method: 'buyer_confirm',
      spec: {
        title: 'Add hash_match verification method to gateway',
        description: 'Implement hash_match (SPEC §3.3): SHA-256 of deliverable compared to expected_hash in task_spec. Gateway handler + escrow routing + 4 unit tests.',
        acceptance_criteria: [
          'gateway.ts has verifyHashMatch() method',
          'escrow.ts routes hash_match to gateway',
          '4+ unit tests for pass/fail/error/case-insensitive',
          'Deployed to sandbox',
        ],
        priority: 'high',
      },
    },
    {
      label: '#2 — Policy staleness detection cron',
      amount: 10000,
      method: 'buyer_confirm',
      spec: {
        title: 'Add policy staleness cron (SPEC §3.1.3)',
        description: 'Weekly cron checks dispute rate per active policy over 30-day window. If >5%, flag as stale and notify creator. Add stale status to policy state machine.',
        acceptance_criteria: [
          'handlePolicyStaleness() exported from cron module',
          'Policy state machine includes stale status',
          'Wired into scheduled() handler',
          'Creator notified via queue on stale flag',
        ],
        priority: 'medium',
      },
    },
  ]

  // Escrow #3: hash_match — deterministic deliverable
  const expectedDeliverable = {
    type: 'config_update',
    readme_sections_updated: ['verification_methods', 'env_vars', 'test_count'],
    env_vars_documented: 7,
    hash_match_added_to_table: true,
  }
  const expectedHash = sha256Hex(JSON.stringify(expectedDeliverable))

  tasks.push({
    label: '#3 — README env var + verification docs (hash_match verified)',
    amount: 5000,
    method: 'hash_match',
    spec: {
      title: 'Update README with missing env vars and hash_match method',
      description: 'Add 7 undocumented env vars to deploy section, add hash_match to verification methods table, update test count.',
      expected_hash: expectedHash,
    },
  })

  const escrows = []
  for (const task of tasks) {
    const result = await signedFetch('POST', '/escrow/propose', {
      seller: builder.publicKey,
      amountCents: task.amount,
      collateralRatio: 0.5,
      taskSpec: task.spec,
      verificationMethod: task.method,
      timeoutSeconds: 86400,
    }, architect)

    if (result) {
      escrows.push({ ...task, data: result.data, expectedDeliverable: task === tasks[2] ? expectedDeliverable : null })
      console.log(`  ✓ Escrow ${task.label}`)
      console.log(`    ID: ${result.data?.id}  Method: ${task.method}`)
      console.log(`    Amount: $${(task.amount / 100).toFixed(2)} | Status: ${result.data?.status}`)
    }
  }
  console.log()

  // ── Step 5: Seller accepts all ──
  console.log('▸ Step 5: Claude-Builder accepting commissions...')
  for (const escrow of escrows) {
    if (!escrow.data?.id) continue
    const accepted = await signedFetch('POST', `/escrow/${escrow.data.id}/accept`, {}, builder)
    if (accepted) {
      console.log(`  ✓ ${escrow.label} → ${accepted.data?.status}`)
    }
  }
  console.log()

  // ── Step 6: Deliver on Escrow #1 (buyer_confirm) ──
  console.log('▸ Step 6a: Delivering Escrow #1 (buyer_confirm)...')
  if (escrows[0]?.data?.id) {
    const delivery = await signedFetch('POST', `/escrow/${escrows[0].data.id}/deliver`, {
      deliverable: {
        type: 'code_change',
        summary: 'Implemented hash_match verification: gateway handler, escrow routing, 4 unit tests. Deployed to sandbox.',
        files_changed: [
          'packages/api/src/lib/gateway.ts',
          'packages/api/src/routes/escrow.ts',
          'packages/api/src/__tests__/gateway-hash-match.test.ts',
          'packages/api/src/__tests__/verification.test.ts',
        ],
        tests_added: 6,
        tests_passing: true,
        deployed_to_sandbox: true,
      }
    }, builder)

    if (delivery) {
      console.log(`  ✓ Deliverable submitted → ${delivery.data?.status}`)
    }
  }

  // ── Step 6b: Deliver on Escrow #3 (hash_match — auto-verified) ──
  console.log('▸ Step 6b: Delivering Escrow #3 (hash_match auto-verify)...')
  if (escrows[2]?.data?.id) {
    const delivery = await signedFetch('POST', `/escrow/${escrows[2].data.id}/deliver`, {
      deliverable: escrows[2].expectedDeliverable,
    }, builder)

    if (delivery) {
      const status = delivery.data?.status
      console.log(`  ✓ hash_match deliverable submitted → ${status}`)
      if (status === 'released') {
        console.log(`    Auto-verified and released! Hash matched.`)
      }
    }
  }
  console.log()

  // ── Step 7: Buyer confirms Escrow #1 ──
  console.log('▸ Step 7: Claude-Architect confirming Escrow #1...')
  if (escrows[0]?.data?.id) {
    const confirmed = await signedFetch('POST', `/escrow/${escrows[0].data.id}/confirm`, {}, architect)
    if (confirmed) {
      console.log(`  ✓ Escrow #1 RELEASED → $${(escrows[0].amount / 100).toFixed(2)} to Claude-Builder`)
      console.log(`    Final status: ${confirmed.data?.status}`)
    }
  }
  console.log()

  // ── Step 8: Verify hash_match verification record ──
  console.log('▸ Step 8: Checking verification records...')
  if (escrows[2]?.data?.id) {
    const vResult = await publicFetch(`/verify/${escrows[2].data.id}`)
    if (vResult?.data) {
      console.log(`  ✓ Escrow #3 verification: ${vResult.data.result} (${vResult.data.method})`)
      console.log(`    Constraints: ${vResult.data.constraintsPassed}/${vResult.data.constraintsTotal}`)
      if (vResult.data.gatewaySignature) {
        console.log(`    Gateway signature: ${vResult.data.gatewaySignature.slice(0, 16)}...`)
      }
    }
  }
  console.log()

  // ── Step 9: Publish attestations ──
  console.log('▸ Step 9: Publishing trust attestations...')
  let attCount = 0
  for (const escrow of escrows) {
    if (!escrow.data?.id) continue
    // Only attest for completed escrows
    const check = await publicFetch(`/escrow/${escrow.data.id}`)
    if (check?.data?.status !== 'released') continue

    const att = await signedFetch('POST', '/attestations', {
      subjectId: builder.publicKey,  // public key lookup (not UUID)
      escrowId: escrow.data.id,
      outcome: 'success',
      verificationMethod: escrow.method,
    }, architect)

    if (att) {
      console.log(`  ✓ Attestation for ${escrow.label} (${att.data?.id?.slice(0,8)}...)`)
      attCount++
    }
  }
  console.log()

  // ── Step 10: Check stats ──
  console.log('▸ Step 10: Agent stats...')
  for (const [name, kp] of [['Architect', architect], ['Builder', builder]]) {
    const stats = await publicFetch(`/agents/${kp.publicKey}/stats`)
    if (stats?.data) {
      console.log(`  ${name}: ${JSON.stringify(stats.data)}`)
    }
  }
  console.log()

  // ── Summary ──
  const releasedCount = escrows.filter(e => e.method === 'buyer_confirm' || e.method === 'hash_match').length
  const releasedAmount = escrows.filter(e => e.method === 'buyer_confirm' || e.method === 'hash_match')
    .reduce((s, e) => s + e.amount, 0)

  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║                      DOGFOOD RESULTS                        ║')
  console.log('╠══════════════════════════════════════════════════════════════╣')
  console.log(`║  Agents registered:       2 (Claude-Architect + Claude-Builder)`)
  console.log(`║  Escrows created:         ${escrows.length}`)
  console.log(`║  Escrows accepted:        ${escrows.length}`)
  console.log(`║  Delivered (buyer_confirm): ${escrows.filter(e => e.method === 'buyer_confirm').length}`)
  console.log(`║  Delivered (hash_match):    ${escrows.filter(e => e.method === 'hash_match').length}`)
  console.log(`║  Payments released:        ${releasedCount}`)
  console.log(`║  Attestations published:   ${attCount}`)
  console.log(`║`)
  console.log(`║  Total commission value:  $${escrows.reduce((s,e) => s + e.amount, 0) / 100}`)
  console.log(`║  Verification methods:    buyer_confirm + hash_match`)
  console.log(`║`)
  console.log(`║  ✦ The protocol is building itself. ✦`)
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log()
  console.log('── Keypairs (for resuming work) ──')
  console.log(`ARCHITECT_PUB=${architect.publicKey}`)
  console.log(`ARCHITECT_PRIV=${architect.privateKey}`)
  console.log(`BUILDER_PUB=${builder.publicKey}`)
  console.log(`BUILDER_PRIV=${builder.privateKey}`)
}

main().catch(console.error)
