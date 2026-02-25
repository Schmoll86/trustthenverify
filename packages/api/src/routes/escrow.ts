import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { snakeToCamel } from '../lib/case'
import { success, error } from '../lib/response'
import { sha256Hex } from '@trustthenverify/sdk'
import { canTransition } from '../lib/escrow-state'
import type { StripeService } from '../lib/stripe'
import { RealStripeService } from '../lib/stripe'
import type { GatewayService } from '../lib/gateway'
import { RealGatewayService } from '../lib/gateway'
import type { OnchainService } from '../lib/onchain'
import { RealOnchainService } from '../lib/onchain'
import type { Escrow } from '@trustthenverify/sdk'
import type { EscrowRow } from '../lib/types'

type AppEnv = {
  Bindings: Env
  Variables: {
    agentPubkey?: string
    agentId?: string
    sandboxMode?: boolean
    rawBody?: string
    stripe?: StripeService
    gateway?: GatewayService
    onchain?: OnchainService
  }
}

export const escrow = new Hono<AppEnv>()

/** Get or create StripeService. Tests inject via c.set('stripe', mock). */
function getStripe(c: { env: Env; get(key: 'stripe'): StripeService | undefined }): StripeService {
  const injected = c.get('stripe')
  if (injected) return injected
  return new RealStripeService(c.env.STRIPE_SECRET_KEY)
}

/** Get or create GatewayService. Tests inject via c.set('gateway', mock). */
function getGateway(c: { env: Env; get(key: 'gateway'): GatewayService | undefined }): GatewayService {
  const injected = c.get('gateway')
  if (injected) return injected
  const db = createDb(c.env)
  return new RealGatewayService(c.env.GATEWAY_PRIVATE_KEY, async (policyId: string) => {
    const { data } = await db.from('policies').select('*').eq('id', policyId).single()
    return data as { id: string; status: string; formal_spec: Record<string, unknown> } | null
  })
}

/** Get or create OnchainService. Tests inject via c.set('onchain', mock). */
function getOnchain(c: { env: Env; get(key: 'onchain'): OnchainService | undefined }): OnchainService {
  const injected = c.get('onchain')
  if (injected) return injected
  return new RealOnchainService(
    c.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    c.env.ESCROW_FACTORY_ADDRESS ?? '',
    c.env.GATEWAY_EOA_PRIVATE_KEY ?? '',
    parseInt(c.env.BASE_CHAIN_ID ?? '8453', 10),
  )
}

// ── GET /escrow/:id — fetch escrow status (public, no auth) ──────────────────

escrow.get('/:id', async (c) => {
  const id = c.req.param('id')
  const db = createDb(c.env)

  const { data: row } = await db
    .from('escrows')
    .select('*')
    .eq('id', id)
    .single()

  if (!row) {
    return error(c, 404, 'NOT_FOUND', `Escrow not found: ${id}`)
  }

  return success(c, snakeToCamel<Escrow>(row))
})

// ── POST /escrow/propose — buyer proposes escrow terms ───────────────────────

escrow.post('/propose', async (c) => {
  const rawBody = c.get('rawBody')
  let body: {
    seller: string
    amountCents: number
    sellerCollateral: number
    taskSpec: Record<string, unknown>
    policyId?: string
    verificationMethod?: string
    timeoutSeconds?: number
    disputeResolution?: string
    fundingMode?: 'stripe' | 'onchain'
    buyerAddress?: string
    sellerAddress?: string
  }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  const buyerId = c.get('agentId')
  if (!buyerId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  // Validate required fields
  if (!body.seller || typeof body.seller !== 'string') {
    return error(c, 400, 'INVALID_PARAMS', 'seller (public key) is required')
  }
  if (!body.amountCents || body.amountCents <= 0) {
    return error(c, 400, 'INVALID_PARAMS', 'amountCents must be > 0')
  }
  if (!body.taskSpec || typeof body.taskSpec !== 'object') {
    return error(c, 400, 'INVALID_PARAMS', 'taskSpec is required')
  }

  const fundingMode = body.fundingMode ?? 'stripe'

  // On-chain mode requires addresses
  if (fundingMode === 'onchain') {
    if (!body.buyerAddress) {
      return error(c, 400, 'INVALID_PARAMS', 'buyerAddress is required for on-chain escrow')
    }
    if (!body.sellerAddress) {
      return error(c, 400, 'INVALID_PARAMS', 'sellerAddress is required for on-chain escrow')
    }
  }

  const db = createDb(c.env)

  // Verify seller exists
  const { data: seller } = await db
    .from('agents')
    .select('id')
    .eq('public_key', body.seller)
    .single()

  if (!seller) {
    return error(c, 404, 'NOT_FOUND', 'Seller agent not found')
  }

  // Buyer != seller
  if (seller.id === buyerId) {
    return error(c, 400, 'INVALID_PARAMS', 'Buyer and seller must be different agents')
  }

  const taskHash = sha256Hex(JSON.stringify(body.taskSpec))
  const timeoutSeconds = body.timeoutSeconds ?? 3600
  const proposalWindowMs = 15 * 60 * 1000 // 15 minutes
  const expiresAt = new Date(Date.now() + proposalWindowMs).toISOString()

  const { data: row, error: dbError } = await db
    .from('escrows')
    .insert({
      buyer_id: buyerId,
      seller_id: seller.id,
      amount_cents: body.amountCents,
      seller_collateral: body.sellerCollateral ?? 0,
      task_hash: taskHash,
      task_spec: body.taskSpec,
      policy_id: body.policyId ?? null,
      verification_method: body.verificationMethod ?? 'buyer_confirm',
      dispute_resolution: body.disputeResolution ?? 'burn',
      status: 'proposed',
      timeout_seconds: timeoutSeconds,
      expires_at: expiresAt,
      funding_mode: fundingMode,
      buyer_address: body.buyerAddress ?? null,
      seller_address: body.sellerAddress ?? null,
      chain_id: fundingMode === 'onchain' ? parseInt(c.env.BASE_CHAIN_ID ?? '8453', 10) : null,
    })
    .select()
    .single()

  if (dbError || !row) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create escrow')
  }

  return success(c, snakeToCamel<Escrow>(row), 201)
})

// ── POST /escrow/:id/accept — seller accepts + funds atomically ──────────────

escrow.post('/:id/accept', async (c) => {
  const escrowId = c.req.param('id')
  const callerId = c.get('agentId')
  if (!callerId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const db = createDb(c.env)

  const { data: row } = await db
    .from('escrows')
    .select('*')
    .eq('id', escrowId)
    .single()

  if (!row) {
    return error(c, 404, 'NOT_FOUND', `Escrow not found: ${escrowId}`)
  }

  const escrowRow = row as EscrowRow

  // Must be seller
  if (escrowRow.seller_id !== callerId) {
    return error(c, 403, 'FORBIDDEN', 'Only the seller can accept this escrow')
  }

  // Must be in proposed state
  if (!canTransition(escrowRow.status as 'proposed', 'accept')) {
    return error(c, 409, 'INVALID_STATE', `Cannot accept escrow in status: ${escrowRow.status}`)
  }

  // Check if proposal has expired
  if (new Date(escrowRow.expires_at) < new Date()) {
    return error(c, 409, 'EXPIRED', 'Escrow proposal has expired')
  }

  const fundingMode = (escrowRow as unknown as Record<string, unknown>).funding_mode as string ?? 'stripe'

  if (fundingMode === 'onchain') {
    // On-chain mode: proposed → accepted, deploy contract
    const onchain = getOnchain(c as unknown as { env: Env; get(key: 'onchain'): OnchainService | undefined })

    const { contractAddress, txHash } = await onchain.deployEscrow({
      escrowId: escrowRow.id,
      buyer: (escrowRow as unknown as Record<string, unknown>).buyer_address as string,
      seller: (escrowRow as unknown as Record<string, unknown>).seller_address as string,
      amountUsdc: BigInt(escrowRow.amount_cents) * 10000n, // cents → 6 decimal USDC
      collateralUsdc: BigInt(escrowRow.seller_collateral) * 10000n,
      deadlineTimestamp: Math.floor(Date.now() / 1000) + (escrowRow.timeout_seconds ?? 3600),
    })

    // Funding window: 30 min for agents to fund the contract
    const fundingWindowMs = 30 * 60 * 1000
    const fundingExpiry = new Date(Date.now() + fundingWindowMs).toISOString()

    const { data: updated } = await db
      .from('escrows')
      .update({
        status: 'accepted',
        contract_address: contractAddress,
        tx_hash: txHash,
        expires_at: fundingExpiry,
      })
      .eq('id', escrowId)
      .select()
      .single()

    if (!updated) {
      return error(c, 500, 'INTERNAL_ERROR', 'Failed to update escrow')
    }

    return success(c, snakeToCamel<Escrow>(updated))
  }

  // Stripe mode: proposed → active (atomic accept + fund)
  const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
  const { stripeEscrowId } = await stripe.captureEscrowFunds({
    buyerAmountCents: escrowRow.amount_cents,
    sellerCollateralCents: escrowRow.seller_collateral,
    escrowId,
  })

  const timeoutSeconds = (row as Record<string, unknown>).timeout_seconds as number | undefined ?? 3600
  const newExpiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString()

  const { data: updated } = await db
    .from('escrows')
    .update({
      status: 'active',
      stripe_escrow_id: stripeEscrowId,
      funded_at: new Date().toISOString(),
      expires_at: newExpiresAt,
    })
    .eq('id', escrowId)
    .select()
    .single()

  if (!updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update escrow')
  }

  return success(c, snakeToCamel<Escrow>(updated))
})

// ── POST /escrow/:id/fund — agent notifies API of on-chain funding ────────

escrow.post('/:id/fund', async (c) => {
  const escrowId = c.req.param('id')
  const callerId = c.get('agentId')
  if (!callerId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const db = createDb(c.env)

  const { data: row } = await db
    .from('escrows')
    .select('*')
    .eq('id', escrowId)
    .single()

  if (!row) {
    return error(c, 404, 'NOT_FOUND', `Escrow not found: ${escrowId}`)
  }

  const escrowRow = row as EscrowRow

  // Must be on-chain mode
  if (escrowRow.funding_mode !== 'onchain') {
    return error(c, 400, 'INVALID_PARAMS', 'Fund endpoint is only for on-chain escrows')
  }

  // Must be buyer or seller
  if (escrowRow.buyer_id !== callerId && escrowRow.seller_id !== callerId) {
    return error(c, 403, 'FORBIDDEN', 'Only buyer or seller can notify funding')
  }

  // Must be in accepted state
  if (!canTransition(escrowRow.status as 'accepted', 'fund')) {
    return error(c, 409, 'INVALID_STATE', `Cannot fund in status: ${escrowRow.status}`)
  }

  // Check on-chain funding status
  const onchain = getOnchain(c as unknown as { env: Env; get(key: 'onchain'): OnchainService | undefined })
  const funding = await onchain.checkFunding(escrowRow.contract_address ?? '')

  const updateFields: Record<string, unknown> = {
    buyer_funded: funding.buyerFunded,
    seller_funded: funding.sellerFunded,
  }

  if (funding.buyerFunded && funding.sellerFunded) {
    // Both funded → activate
    const timeoutSeconds = escrowRow.timeout_seconds ?? 3600
    const newExpiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString()

    updateFields.status = 'active'
    updateFields.funded_at = new Date().toISOString()
    updateFields.expires_at = newExpiresAt
  }

  const { data: updated } = await db
    .from('escrows')
    .update(updateFields)
    .eq('id', escrowId)
    .select()
    .single()

  if (!updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update escrow')
  }

  return success(c, snakeToCamel<Escrow>(updated))
})

// ── POST /escrow/:id/deliver — seller submits deliverable ────────────────────

escrow.post('/:id/deliver', async (c) => {
  const escrowId = c.req.param('id')
  const callerId = c.get('agentId')
  if (!callerId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const rawBody = c.get('rawBody')
  let body: { deliverable: Record<string, unknown> }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  if (!body.deliverable || typeof body.deliverable !== 'object') {
    return error(c, 400, 'INVALID_PARAMS', 'deliverable is required')
  }

  const db = createDb(c.env)

  const { data: row } = await db
    .from('escrows')
    .select('*')
    .eq('id', escrowId)
    .single()

  if (!row) {
    return error(c, 404, 'NOT_FOUND', `Escrow not found: ${escrowId}`)
  }

  const escrowRow = row as EscrowRow

  // Must be seller
  if (escrowRow.seller_id !== callerId) {
    return error(c, 403, 'FORBIDDEN', 'Only the seller can deliver')
  }

  // Must be active
  if (!canTransition(escrowRow.status as 'active', 'deliver')) {
    return error(c, 409, 'INVALID_STATE', `Cannot deliver in status: ${escrowRow.status}`)
  }

  // Check expiry
  if (new Date(escrowRow.expires_at) < new Date()) {
    return error(c, 409, 'EXPIRED', 'Escrow has expired')
  }

  const proof = sha256Hex(JSON.stringify(body.deliverable))

  // Increment delivery_attempts
  const attempts = ((escrowRow as unknown as Record<string, unknown>).delivery_attempts as number ?? 0) + 1

  const { data: updated } = await db
    .from('escrows')
    .update({
      status: 'delivered',
      proof,
      delivery_attempts: attempts,
    })
    .eq('id', escrowId)
    .select()
    .single()

  if (!updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update escrow')
  }

  // Automated verification for non-buyer_confirm methods
  const method = escrowRow.verification_method
  if (method === 'automated_reasoning' || method === 'schema_validation') {
    const gateway = getGateway(c as unknown as { env: Env; get(key: 'gateway'): GatewayService | undefined })

    const vResult = await gateway.verify({
      escrowId,
      deliverable: body.deliverable,
      verificationMethod: method,
      policyId: escrowRow.policy_id,
      taskSpec: escrowRow.task_spec,
    })

    // Store verification record
    await db.from('verifications').insert({
      escrow_id: escrowId,
      method,
      policy_id: escrowRow.policy_id,
      result: vResult.result,
      constraints_total: vResult.constraintsTotal,
      constraints_passed: vResult.constraintsPassed,
      failure_details: vResult.failures.length > 0 ? { failures: vResult.failures } : null,
      proof_hash: proof,
      gateway_signature: vResult.gatewaySignature,
      verified_at: vResult.verifiedAt,
    })

    if (vResult.result === 'pass') {
      // Auto-release funds
      if (escrowRow.funding_mode === 'onchain' && escrowRow.contract_address) {
        const onchain = getOnchain(c as unknown as { env: Env; get(key: 'onchain'): OnchainService | undefined })
        const gw = getGateway(c as unknown as { env: Env; get(key: 'gateway'): GatewayService | undefined })
        if (gw.signForChain) {
          const sig = await gw.signForChain({
            escrowId, resultDigest: proof, contractAddress: escrowRow.contract_address, action: 'release',
          })
          await onchain.gatewayRelease({
            contractAddress: escrowRow.contract_address, escrowId,
            resultDigest: proof, v: sig.v, r: sig.r, s: sig.s,
          })
        }
      } else if (escrowRow.stripe_escrow_id) {
        const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
        await stripe.releaseFunds({
          stripeEscrowId: escrowRow.stripe_escrow_id,
          sellerAmountCents: escrowRow.amount_cents + escrowRow.seller_collateral,
        })
      }
      const now = new Date().toISOString()
      const { data: released } = await db
        .from('escrows')
        .update({ status: 'released', completed_at: now })
        .eq('id', escrowId)
        .select()
        .single()

      return success(c, snakeToCamel<Escrow>(released ?? updated))
    }

    if (vResult.result === 'fail') {
      // Auto-fail: refund buyer, burn seller collateral
      if (escrowRow.funding_mode === 'onchain' && escrowRow.contract_address) {
        const onchain = getOnchain(c as unknown as { env: Env; get(key: 'onchain'): OnchainService | undefined })
        const gw = getGateway(c as unknown as { env: Env; get(key: 'gateway'): GatewayService | undefined })
        if (gw.signForChain) {
          const sig = await gw.signForChain({
            escrowId, resultDigest: proof, contractAddress: escrowRow.contract_address, action: 'fail',
          })
          await onchain.gatewayFail({
            contractAddress: escrowRow.contract_address, escrowId,
            resultDigest: proof, v: sig.v, r: sig.r, s: sig.s,
          })
        }
      } else if (escrowRow.stripe_escrow_id) {
        const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
        await stripe.refundBuyerAndBurnCollateral({
          stripeEscrowId: escrowRow.stripe_escrow_id,
          buyerRefundCents: escrowRow.amount_cents,
        })
      }
      const now = new Date().toISOString()
      const { data: failed } = await db
        .from('escrows')
        .update({ status: 'failed', completed_at: now })
        .eq('id', escrowId)
        .select()
        .single()

      return success(c, snakeToCamel<Escrow>(failed ?? updated))
    }

    // result === 'error': stay delivered, allow re-delivery
    if (attempts >= 3) {
      // Fallback to buyer_confirm after 3 failed attempts
      await db.from('escrows').update({ verification_method: 'buyer_confirm' }).eq('id', escrowId)
    }

    // Return the delivered state with error info
    return error(c, 422, 'VERIFICATION_ERROR', vResult.failures.map(f => f.error).join('; '))
  }

  return success(c, snakeToCamel<Escrow>(updated))
})

// ── POST /escrow/:id/confirm — buyer confirms delivery ───────────────────────

escrow.post('/:id/confirm', async (c) => {
  const escrowId = c.req.param('id')
  const callerId = c.get('agentId')
  if (!callerId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const db = createDb(c.env)

  const { data: row } = await db
    .from('escrows')
    .select('*')
    .eq('id', escrowId)
    .single()

  if (!row) {
    return error(c, 404, 'NOT_FOUND', `Escrow not found: ${escrowId}`)
  }

  const escrowRow = row as EscrowRow

  // Must be buyer
  if (escrowRow.buyer_id !== callerId) {
    return error(c, 403, 'FORBIDDEN', 'Only the buyer can confirm delivery')
  }

  // Must be delivered
  if (!canTransition(escrowRow.status as 'delivered', 'confirm')) {
    return error(c, 409, 'INVALID_STATE', `Cannot confirm in status: ${escrowRow.status}`)
  }

  // Must be buyer_confirm method
  if (escrowRow.verification_method !== 'buyer_confirm') {
    return error(c, 400, 'INVALID_PARAMS', 'Manual confirmation only available for buyer_confirm verification method')
  }

  // Release funds — branch by funding mode
  if (escrowRow.funding_mode === 'onchain' && escrowRow.contract_address) {
    // On-chain: buyer confirms directly on contract (this API call just records the verification)
    // The actual fund transfer happens on-chain via confirmDelivery()
    // We record it here and update our DB state
  } else if (escrowRow.stripe_escrow_id) {
    const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
    await stripe.releaseFunds({
      stripeEscrowId: escrowRow.stripe_escrow_id,
      sellerAmountCents: escrowRow.amount_cents + escrowRow.seller_collateral,
    })
  }

  const now = new Date().toISOString()

  // Update escrow
  const { data: updated } = await db
    .from('escrows')
    .update({
      status: 'released',
      completed_at: now,
    })
    .eq('id', escrowId)
    .select()
    .single()

  // Insert verification record
  await db
    .from('verifications')
    .insert({
      escrow_id: escrowId,
      method: 'buyer_confirm',
      policy_id: escrowRow.policy_id,
      result: 'pass',
      constraints_total: 0,
      constraints_passed: 0,
      failure_details: null,
      proof_hash: escrowRow.proof,
      gateway_signature: 'buyer_confirm_manual',
      verified_at: now,
    })

  if (!updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update escrow')
  }

  return success(c, snakeToCamel<Escrow>(updated))
})

// ── POST /escrow/:id/dispute — either party disputes ─────────────────────────

escrow.post('/:id/dispute', async (c) => {
  const escrowId = c.req.param('id')
  const callerId = c.get('agentId')
  if (!callerId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const rawBody = c.get('rawBody')
  let body: { reason?: string }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  const db = createDb(c.env)

  const { data: row } = await db
    .from('escrows')
    .select('*')
    .eq('id', escrowId)
    .single()

  if (!row) {
    return error(c, 404, 'NOT_FOUND', `Escrow not found: ${escrowId}`)
  }

  const escrowRow = row as EscrowRow

  // Must be buyer or seller
  if (escrowRow.buyer_id !== callerId && escrowRow.seller_id !== callerId) {
    return error(c, 403, 'FORBIDDEN', 'Only buyer or seller can dispute')
  }

  // Must be active or delivered
  if (!canTransition(escrowRow.status as 'active' | 'delivered', 'dispute')) {
    return error(c, 409, 'INVALID_STATE', `Cannot dispute in status: ${escrowRow.status}`)
  }

  const now = new Date().toISOString()

  // Burn mode: immediate burn
  if (escrowRow.dispute_resolution === 'burn') {
    if (escrowRow.funding_mode === 'onchain' && escrowRow.contract_address) {
      // On-chain dispute happens directly on contract — just update DB state
      // Agents call dispute() on the contract themselves
    } else if (escrowRow.stripe_escrow_id) {
      const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
      await stripe.burnFunds({ stripeEscrowId: escrowRow.stripe_escrow_id })
    }

    const { data: updated } = await db
      .from('escrows')
      .update({
        status: 'burned',
        completed_at: now,
      })
      .eq('id', escrowId)
      .select()
      .single()

    // Insert dispute record
    await db
      .from('disputes')
      .insert({
        escrow_id: escrowId,
        initiator_id: callerId,
        reason: body.reason ?? null,
        status: 'resolved',
        resolved_at: now,
      })

    if (!updated) {
      return error(c, 500, 'INTERNAL_ERROR', 'Failed to update escrow')
    }

    return success(c, snakeToCamel<Escrow>(updated))
  }

  // Arbitrate mode (future) — just record the dispute
  return error(c, 501, 'NOT_IMPLEMENTED', 'Arbitration mode not yet supported')
})
