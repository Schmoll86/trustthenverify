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
import type { ArbitrationService } from '../lib/arbitration-service'
import { RealArbitrationService } from '../lib/arbitration-service'
import { RealLLMService } from '../lib/openrouter'
import type { Escrow } from '@trustthenverify/sdk'
import type { EscrowRow, AgentRow } from '../lib/types'

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
    arbitration?: ArbitrationService
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
    c.env.GATEWAY_EOA_PRIVATE_KEY ?? c.env.GATEWAY_PRIVATE_KEY ?? '',
    parseInt(c.env.BASE_CHAIN_ID ?? '8453', 10),
  )
}

/** Get or create ArbitrationService. Tests inject via c.set('arbitration', mock). */
function getArbitration(c: { env: Env; get(key: 'arbitration'): ArbitrationService | undefined }): ArbitrationService | null {
  const injected = c.get('arbitration')
  if (injected) return injected
  if (!c.env.OPENROUTER_API_KEY) return null
  const model = c.env.ARBITRATION_MODEL ?? 'google/gemini-2.5-flash'
  const llm = new RealLLMService(c.env.OPENROUTER_API_KEY)
  return new RealArbitrationService(llm, model)
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
    buyerPaymentMethodId?: string
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
      dispute_resolution: body.disputeResolution ?? 'arbitrate',
      status: 'proposed',
      timeout_seconds: timeoutSeconds,
      expires_at: expiresAt,
      funding_mode: fundingMode,
      buyer_address: body.buyerAddress ?? null,
      seller_address: body.sellerAddress ?? null,
      chain_id: fundingMode === 'onchain' ? parseInt(c.env.BASE_CHAIN_ID ?? '8453', 10) : null,
      buyer_payment_method_id: body.buyerPaymentMethodId ?? null,
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
    let contractAddress = 'sandbox_mock_contract'
    let txHash = 'sandbox_mock_tx'

    if (!c.get('sandboxMode')) {
      // On-chain mode: proposed → accepted, deploy contract
      const onchain = getOnchain(c as unknown as { env: Env; get(key: 'onchain'): OnchainService | undefined })

      try {
        const deployed = await onchain.deployEscrow({
          escrowId: escrowRow.id,
          buyer: (escrowRow as unknown as Record<string, unknown>).buyer_address as string,
          seller: (escrowRow as unknown as Record<string, unknown>).seller_address as string,
          amountUsdc: BigInt(escrowRow.amount_cents) * 10000n, // cents → 6 decimal USDC
          collateralUsdc: BigInt(escrowRow.seller_collateral) * 10000n,
          deadlineTimestamp: Math.floor(Date.now() / 1000) + (escrowRow.timeout_seconds ?? 3600),
        })
        contractAddress = deployed.contractAddress
        txHash = deployed.txHash
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('On-chain deploy failed:', msg)
        return error(c, 500, 'ONCHAIN_DEPLOY_FAILED', msg)
      }
    }

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
  let stripeBuyerPiId: string = 'sandbox_mock'
  let stripeSellerCollateralPiId: string | null = null

  if (c.get('sandboxMode')) {
    // Sandbox: skip real Stripe calls
  } else {
    // Look up buyer + seller Stripe identities
    const { data: buyerAgent } = await db
      .from('agents')
      .select('*')
      .eq('id', escrowRow.buyer_id)
      .single()

    const buyerRow = buyerAgent as AgentRow | null
    if (!buyerRow?.stripe_customer_id) {
      return error(c, 400, 'STRIPE_NOT_CONFIGURED', 'Buyer must set up Stripe Customer first')
    }

    const buyerPaymentMethodId = (escrowRow as unknown as Record<string, unknown>).buyer_payment_method_id as string | null
      ?? buyerRow.stripe_default_payment_method
    if (!buyerPaymentMethodId) {
      return error(c, 400, 'STRIPE_NOT_CONFIGURED', 'Buyer must attach a payment method first')
    }

    const { data: sellerAgent } = await db
      .from('agents')
      .select('*')
      .eq('id', escrowRow.seller_id)
      .single()

    const sellerRow = sellerAgent as AgentRow | null
    if (!sellerRow?.stripe_connected_account_id || !sellerRow.stripe_onboarding_complete) {
      return error(c, 400, 'STRIPE_NOT_CONFIGURED', 'Seller must complete Stripe Connect onboarding first')
    }

    const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
    const result = await stripe.captureEscrowFunds({
      buyerAmountCents: escrowRow.amount_cents,
      sellerCollateralCents: escrowRow.seller_collateral,
      escrowId,
      buyerCustomerId: buyerRow.stripe_customer_id,
      buyerPaymentMethodId,
      sellerCustomerId: sellerRow.stripe_customer_id ?? undefined,
      sellerPaymentMethodId: sellerRow.stripe_default_payment_method ?? undefined,
    })
    stripeBuyerPiId = result.stripeBuyerPiId
    stripeSellerCollateralPiId = result.stripeSellerCollateralPiId
  }

  const timeoutSeconds = (row as Record<string, unknown>).timeout_seconds as number | undefined ?? 3600
  const newExpiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString()

  const { data: updated } = await db
    .from('escrows')
    .update({
      status: 'active',
      stripe_escrow_id: stripeBuyerPiId, // backward compat
      stripe_buyer_pi_id: stripeBuyerPiId,
      stripe_seller_collateral_pi_id: stripeSellerCollateralPiId,
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

  if (method === 'oracle_consensus') {
    // Dispatch to oracle pool via queue
    await c.env.QUEUE.send({
      type: 'oracle_dispatch',
      escrowId,
      deliverable: body.deliverable,
    })
    return success(c, snakeToCamel<Escrow>(updated))
  }

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
      } else if (escrowRow.stripe_buyer_pi_id ?? escrowRow.stripe_escrow_id) {
        const buyerPiId = escrowRow.stripe_buyer_pi_id ?? escrowRow.stripe_escrow_id!
        // Look up seller's connected account for transfer
        const { data: sellerAgent } = await db
          .from('agents')
          .select('*')
          .eq('id', escrowRow.seller_id)
          .single()
        const sellerRow = sellerAgent as AgentRow | null
        if (sellerRow?.stripe_connected_account_id) {
          const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
          const { transferId } = await stripe.releaseFunds({
            stripeBuyerPiId: buyerPiId,
            sellerConnectedAccountId: sellerRow.stripe_connected_account_id,
            sellerAmountCents: escrowRow.amount_cents,
            stripeSellerCollateralPiId: escrowRow.stripe_seller_collateral_pi_id ?? undefined,
          })
          await db.from('escrows').update({ stripe_transfer_id: transferId }).eq('id', escrowId)
        }
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
      } else if (escrowRow.stripe_buyer_pi_id ?? escrowRow.stripe_escrow_id) {
        const buyerPiId = escrowRow.stripe_buyer_pi_id ?? escrowRow.stripe_escrow_id!
        const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
        await stripe.refundBuyerAndBurnCollateral({
          stripeBuyerPiId: buyerPiId,
          buyerRefundCents: escrowRow.amount_cents,
          stripeSellerCollateralPiId: escrowRow.stripe_seller_collateral_pi_id ?? undefined,
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

  // Release funds — branch by funding mode (skip in sandbox)
  if (c.get('sandboxMode')) {
    // Sandbox: skip real payment calls
  } else if (escrowRow.funding_mode === 'onchain' && escrowRow.contract_address) {
    // On-chain: buyer confirms directly on contract (this API call just records the verification)
    // The actual fund transfer happens on-chain via confirmDelivery()
    // We record it here and update our DB state
  } else if (escrowRow.stripe_buyer_pi_id ?? escrowRow.stripe_escrow_id) {
    const buyerPiId = escrowRow.stripe_buyer_pi_id ?? escrowRow.stripe_escrow_id!
    // Look up seller's connected account
    const { data: sellerAgent } = await db
      .from('agents')
      .select('*')
      .eq('id', escrowRow.seller_id)
      .single()
    const sellerRow = sellerAgent as AgentRow | null
    if (sellerRow?.stripe_connected_account_id) {
      const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
      const { transferId } = await stripe.releaseFunds({
        stripeBuyerPiId: buyerPiId,
        sellerConnectedAccountId: sellerRow.stripe_connected_account_id,
        sellerAmountCents: escrowRow.amount_cents,
        stripeSellerCollateralPiId: escrowRow.stripe_seller_collateral_pi_id ?? undefined,
      })
      await db.from('escrows').update({ stripe_transfer_id: transferId }).eq('id', escrowId)
    }
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

  const disputeMode = escrowRow.dispute_resolution ?? 'arbitrate'

  // Check valid transition based on mode
  const action = disputeMode === 'burn' ? 'dispute' : 'dispute_arbitrate'
  if (!canTransition(escrowRow.status as 'active' | 'delivered', action)) {
    return error(c, 409, 'INVALID_STATE', `Cannot dispute in status: ${escrowRow.status}`)
  }

  const now = new Date().toISOString()

  // Burn mode: immediate burn
  if (disputeMode === 'burn') {
    if (!c.get('sandboxMode')) {
      if (escrowRow.funding_mode === 'onchain' && escrowRow.contract_address) {
        // On-chain dispute happens directly on contract — just update DB state
      } else if (escrowRow.stripe_buyer_pi_id ?? escrowRow.stripe_escrow_id) {
        const buyerPiId = escrowRow.stripe_buyer_pi_id ?? escrowRow.stripe_escrow_id!
        const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
        await stripe.burnFunds({
          stripeBuyerPiId: buyerPiId,
          stripeSellerCollateralPiId: escrowRow.stripe_seller_collateral_pi_id ?? undefined,
        })
      }
    }

    const { data: updated } = await db
      .from('escrows')
      .update({ status: 'burned', completed_at: now })
      .eq('id', escrowId)
      .select()
      .single()

    await db.from('disputes').insert({
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

  // ── Arbitrate mode: LLM judges, loser pays 10% fee ──────────────────────

  // 1. Set escrow to disputed
  const { data: disputed } = await db
    .from('escrows')
    .update({ status: 'disputed' })
    .eq('id', escrowId)
    .select()
    .single()

  if (!disputed) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update escrow')
  }

  // 2. Insert dispute record
  const { data: disputeRecord } = await db
    .from('disputes')
    .insert({
      escrow_id: escrowId,
      initiator_id: callerId,
      reason: body.reason ?? null,
      status: 'pending',
    })
    .select()
    .single()

  // 3. Gather evidence
  const initiatorRole = escrowRow.buyer_id === callerId ? 'buyer' : 'seller'

  // Get policy if exists
  let policy: { intent: string; formalSpec?: Record<string, unknown> } | null = null
  if (escrowRow.policy_id) {
    const { data: policyRow } = await db
      .from('policies')
      .select('intent, formal_spec')
      .eq('id', escrowRow.policy_id)
      .single()
    if (policyRow) {
      policy = { intent: policyRow.intent, formalSpec: policyRow.formal_spec }
    }
  }

  // Get verification results
  const { data: verifications } = await db
    .from('verifications')
    .select('method, result, failure_details')
    .eq('escrow_id', escrowId)

  const verificationResults = verifications?.map((v: Record<string, unknown>) => ({
    method: v.method as string,
    result: v.result as string,
    failures: (v.failure_details as Record<string, unknown>)?.failures as unknown[] | undefined,
  })) ?? null

  // 4. Call LLM arbitrator
  const arbitrationSvc = getArbitration(c as unknown as { env: Env; get(key: 'arbitration'): ArbitrationService | undefined })
  if (!arbitrationSvc) {
    // No OpenRouter key — leave dispute pending for manual resolution
    return success(c, snakeToCamel<Escrow>(disputed))
  }

  let ruling: { ruling: 'buyer_wins' | 'seller_wins'; rationale: string; confidence: number }
  try {
    ruling = await arbitrationSvc.arbitrate({
      escrowId,
      taskSpec: escrowRow.task_spec,
      policy,
      verificationResults,
      disputeReason: body.reason ?? 'No reason provided',
      initiatorRole: initiatorRole as 'buyer' | 'seller',
      amountCents: escrowRow.amount_cents,
      deliverable: escrowRow.proof ? null : null, // proof hash only, no deliverable stored
    })
  } catch (err) {
    // LLM failed — leave dispute open for retry
    return error(c, 502, 'ARBITRATION_FAILED', err instanceof Error ? err.message : 'Arbitration failed')
  }

  // 5. Calculate 10% fee
  const feeCents = Math.round(escrowRow.amount_cents * 0.10)
  const netCents = escrowRow.amount_cents - feeCents

  // 6. Execute ruling
  if (ruling.ruling === 'buyer_wins') {
    // Refund buyer (minus 10% fee), keep seller collateral
    if (!c.get('sandboxMode')) {
      if (escrowRow.stripe_buyer_pi_id ?? escrowRow.stripe_escrow_id) {
        const buyerPiId = escrowRow.stripe_buyer_pi_id ?? escrowRow.stripe_escrow_id!
        const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
        await stripe.refundBuyerAndBurnCollateral({
          stripeBuyerPiId: buyerPiId,
          buyerRefundCents: netCents,
          stripeSellerCollateralPiId: escrowRow.stripe_seller_collateral_pi_id ?? undefined,
        })
      }
    }

    const { data: finalEscrow } = await db
      .from('escrows')
      .update({ status: 'failed', completed_at: now })
      .eq('id', escrowId)
      .select()
      .single()

    // Update dispute record
    await db.from('disputes').update({
      ruling: 'buyer_wins',
      status: 'resolved',
      resolved_at: now,
      evidence_hash: JSON.stringify({ rationale: ruling.rationale, confidence: ruling.confidence, fee: feeCents }),
    }).eq('id', disputeRecord?.id ?? '')

    return success(c, snakeToCamel<Escrow>(finalEscrow ?? disputed))
  }

  // seller_wins: transfer to seller (minus 10% fee), return collateral
  if (!c.get('sandboxMode')) {
    if (escrowRow.stripe_buyer_pi_id ?? escrowRow.stripe_escrow_id) {
      const buyerPiId = escrowRow.stripe_buyer_pi_id ?? escrowRow.stripe_escrow_id!
      const { data: sellerAgent } = await db
        .from('agents')
        .select('*')
        .eq('id', escrowRow.seller_id)
        .single()
      const sellerRow = sellerAgent as AgentRow | null
      if (sellerRow?.stripe_connected_account_id) {
        const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
        const { transferId } = await stripe.releaseFunds({
          stripeBuyerPiId: buyerPiId,
          sellerConnectedAccountId: sellerRow.stripe_connected_account_id,
          sellerAmountCents: netCents,
          stripeSellerCollateralPiId: escrowRow.stripe_seller_collateral_pi_id ?? undefined,
        })
        await db.from('escrows').update({ stripe_transfer_id: transferId }).eq('id', escrowId)
      }
    }
  }

  const { data: finalEscrow } = await db
    .from('escrows')
    .update({ status: 'released', completed_at: now })
    .eq('id', escrowId)
    .select()
    .single()

  await db.from('disputes').update({
    ruling: 'seller_wins',
    status: 'resolved',
    resolved_at: now,
    evidence_hash: JSON.stringify({ rationale: ruling.rationale, confidence: ruling.confidence, fee: feeCents }),
  }).eq('id', disputeRecord?.id ?? '')

  return success(c, snakeToCamel<Escrow>(finalEscrow ?? disputed))
})
