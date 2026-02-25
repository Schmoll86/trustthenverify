import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { snakeToCamel } from '../lib/case'
import { success, error } from '../lib/response'
import { sha256Hex } from '@trustthenverify/sdk'
import { canTransition } from '../lib/escrow-state'
import type { StripeService } from '../lib/stripe'
import { RealStripeService } from '../lib/stripe'
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
  }
}

export const escrow = new Hono<AppEnv>()

/** Get or create StripeService. Tests inject via c.set('stripe', mock). */
function getStripe(c: { env: Env; get(key: 'stripe'): StripeService | undefined }): StripeService {
  const injected = c.get('stripe')
  if (injected) return injected
  return new RealStripeService(c.env.STRIPE_SECRET_KEY)
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

  // Capture funds via Stripe
  const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
  const { stripeEscrowId } = await stripe.captureEscrowFunds({
    buyerAmountCents: escrowRow.amount_cents,
    sellerCollateralCents: escrowRow.seller_collateral,
    escrowId,
  })

  // Atomic transition: proposed → active (Stripe mode per §2.2)
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

  const { data: updated } = await db
    .from('escrows')
    .update({
      status: 'delivered',
      proof,
    })
    .eq('id', escrowId)
    .select()
    .single()

  if (!updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update escrow')
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

  // Release funds
  const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
  if (escrowRow.stripe_escrow_id) {
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
    const stripe = getStripe(c as unknown as { env: Env; get(key: 'stripe'): StripeService | undefined })
    if (escrowRow.stripe_escrow_id) {
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
