/**
 * Cron handler: sweep expired escrows + check on-chain funding.
 * Runs on Cloudflare Workers scheduled event.
 */

import { createDb, type Env } from '../lib/db'
import { RealStripeService } from '../lib/stripe'
import type { StripeService } from '../lib/stripe'
import type { OnchainService } from '../lib/onchain'
import { RealOnchainService } from '../lib/onchain'
import type { EscrowRow, OracleTaskRow, OraclePaymentRow, AgentRow } from '../lib/types'
import { RealOracleService } from '../lib/oracle-service'
import type { OracleService } from '../lib/oracle-service'
import { checkConsensus } from '../lib/oracle-service'

/** Best-effort notification enqueue for cron events. */
async function notifyCron(env: Env, agentId: string, eventType: string, escrowId: string, payload: Record<string, unknown> = {}): Promise<void> {
  try {
    await env.QUEUE.send({ type: 'notification', agentId, eventType, escrowId, payload })
  } catch (e) {
    console.error('notifyCron failed:', e)
  }
}

export async function handleEscrowTimeout(
  env: Env,
  stripe?: StripeService,
  onchain?: OnchainService,
): Promise<{ processed: number }> {
  const db = createDb(env)
  const stripeService = stripe ?? new RealStripeService(env.STRIPE_SECRET_KEY)
  const now = new Date().toISOString()

  // Query escrows that are proposed, accepted, or active and past their expiry
  const { data: expired } = await db
    .from('escrows')
    .select('*')
    .in('status', ['proposed', 'accepted', 'active'])
    .lt('expires_at', now)

  if (!expired || expired.length === 0) {
    return { processed: 0 }
  }

  let processed = 0

  for (const row of expired as EscrowRow[]) {
    if (row.status === 'proposed') {
      // No funds involved, just mark expired
      await db
        .from('escrows')
        .update({ status: 'expired', completed_at: now })
        .eq('id', row.id)
      // Notify buyer their proposal expired
      await notifyCron(env, row.buyer_id, 'escrow.expired', row.id, { status: 'expired' })
    } else if (row.status === 'accepted') {
      // On-chain: funding window expired before both funded
      if (row.funding_mode === 'onchain' && row.contract_address) {
        const svc = onchain ?? createOnchainService(env)
        try {
          await svc.triggerTimeout(row.contract_address)
        } catch {
          // Non-fatal: contract may already be timed out
        }
      }
      await db
        .from('escrows')
        .update({ status: 'expired', completed_at: now })
        .eq('id', row.id)
      // Notify both parties of expiration
      await notifyCron(env, row.buyer_id, 'escrow.expired', row.id, { status: 'expired' })
      await notifyCron(env, row.seller_id, 'escrow.expired', row.id, { status: 'expired' })
    } else if (row.status === 'active') {
      // Refund buyer, burn seller collateral
      if (row.funding_mode === 'onchain' && row.contract_address) {
        const svc = onchain ?? createOnchainService(env)
        try {
          await svc.triggerTimeout(row.contract_address)
        } catch {
          // Non-fatal
        }
      } else if (row.stripe_buyer_pi_id ?? row.stripe_escrow_id) {
        const buyerPiId = row.stripe_buyer_pi_id ?? row.stripe_escrow_id!
        await stripeService.refundBuyerAndBurnCollateral({
          stripeBuyerPiId: buyerPiId,
          buyerRefundCents: row.amount_cents,
          stripeSellerCollateralPiId: row.stripe_seller_collateral_pi_id ?? undefined,
        })
      }
      await db
        .from('escrows')
        .update({ status: 'expired', completed_at: now })
        .eq('id', row.id)
      // Notify both parties of active escrow expiration
      await notifyCron(env, row.buyer_id, 'escrow.expired', row.id, { status: 'expired', amountCents: row.amount_cents })
      await notifyCron(env, row.seller_id, 'escrow.expired', row.id, { status: 'expired', amountCents: row.amount_cents })
    }
    processed++
  }

  return { processed }
}

/** Check on-chain funding for accepted escrows and activate if both funded. */
export async function handleOnchainFunding(
  env: Env,
  onchain?: OnchainService,
): Promise<{ activated: number }> {
  const db = createDb(env)

  // Query accepted on-chain escrows that haven't expired yet
  const now = new Date().toISOString()
  const { data: pending } = await db
    .from('escrows')
    .select('*')
    .eq('status', 'accepted')
    .eq('funding_mode', 'onchain')

  if (!pending || pending.length === 0) {
    return { activated: 0 }
  }

  const svc = onchain ?? createOnchainService(env)
  let activated = 0

  for (const row of pending as EscrowRow[]) {
    if (!row.contract_address) continue

    // Check if past funding window
    if (new Date(row.expires_at) < new Date(now)) continue // let timeout handler deal with it

    const funding = await svc.checkFunding(row.contract_address)

    if (funding.buyerFunded && funding.sellerFunded) {
      const timeoutSeconds = row.timeout_seconds ?? 3600
      const newExpiresAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString()

      await db
        .from('escrows')
        .update({
          status: 'active',
          buyer_funded: true,
          seller_funded: true,
          funded_at: new Date().toISOString(),
          expires_at: newExpiresAt,
        })
        .eq('id', row.id)
      activated++
    } else {
      // Update partial funding status
      await db
        .from('escrows')
        .update({
          buyer_funded: funding.buyerFunded,
          seller_funded: funding.sellerFunded,
        })
        .eq('id', row.id)
    }
  }

  return { activated }
}

/** Sweep expired oracle tasks — resolve with partial votes or fallback to buyer_confirm. */
export async function handleOracleTimeout(
  env: Env,
  oracleService?: OracleService,
): Promise<{ processed: number }> {
  const db = createDb(env)
  const oracle = oracleService ?? new RealOracleService(db, env)
  const now = new Date().toISOString()

  // Query voting oracle tasks past their expiry
  const { data: expired } = await db
    .from('oracle_tasks')
    .select('*')
    .eq('status', 'voting')
    .lt('expires_at', now)

  if (!expired || expired.length === 0) {
    return { processed: 0 }
  }

  let processed = 0

  for (const row of expired as OracleTaskRow[]) {
    // Expire pending votes
    await db
      .from('oracle_votes')
      .update({ status: 'expired' })
      .eq('oracle_task_id', row.id)
      .eq('status', 'pending')

    // Check if quorum was reached with partial votes
    const result = checkConsensus(row.votes_pass, row.votes_fail, row.quorum, row.total_oracles)

    if (result.decided && result.consensus !== 'no_consensus') {
      // Quorum reached despite timeout — finalize with result
      await db
        .from('oracle_tasks')
        .update({
          status: 'decided',
          consensus: result.consensus,
          decided_at: now,
        })
        .eq('id', row.id)

      await oracle.finalizeTask(row.id, result.consensus)
    } else {
      // No quorum — mark expired, fallback to buyer_confirm
      await db
        .from('oracle_tasks')
        .update({
          status: 'expired',
          consensus: 'no_consensus',
          decided_at: now,
        })
        .eq('id', row.id)

      // Fallback: change escrow verification to buyer_confirm
      await db
        .from('escrows')
        .update({ verification_method: 'buyer_confirm' })
        .eq('id', row.escrow_id)

      // Still finalize to create payment records for oracles who voted
      await oracle.finalizeTask(row.id, 'no_consensus')
    }

    processed++
  }

  return { processed }
}

/** Auto-refinement: weekly check for policies with high dispute rates. */
export async function handleAutoRefinement(
  env: Env,
): Promise<{ enqueued: number }> {
  const db = createDb(env)
  const disputeThreshold = parseInt(env.AUTO_REFINE_DISPUTE_THRESHOLD ?? '3', 10)

  // Find active policies with high dispute rates and no active refinement
  // Count disputes per policy via escrows
  const { data: policiesWithDisputes } = await db
    .from('escrows')
    .select('policy_id')
    .eq('status', 'disputed')
    .not('policy_id', 'is', null)

  if (!policiesWithDisputes || policiesWithDisputes.length === 0) {
    return { enqueued: 0 }
  }

  // Count disputes per policy
  const disputeCounts = new Map<string, number>()
  for (const row of policiesWithDisputes) {
    const policyId = row.policy_id as string
    disputeCounts.set(policyId, (disputeCounts.get(policyId) ?? 0) + 1)
  }

  let enqueued = 0

  for (const [policyId, count] of disputeCounts) {
    if (count < disputeThreshold) continue

    // Check no active refinement exists
    const { data: activeRefinement } = await db
      .from('refinements')
      .select('id')
      .eq('policy_id', policyId)
      .eq('status', 'running')
      .limit(1)

    if (activeRefinement && activeRefinement.length > 0) continue

    // Enqueue argus_refine
    await env.QUEUE.send({
      type: 'argus_refine',
      policyId,
      budget: 5,
    })
    enqueued++
  }

  return { enqueued }
}

/** Disburse pending oracle payments to connected accounts. */
export async function handleOraclePayouts(
  env: Env,
  stripe?: StripeService,
): Promise<{ paid: number; skipped: number }> {
  const db = createDb(env)
  const stripeService = stripe ?? new RealStripeService(env.STRIPE_SECRET_KEY)

  const { data: pending } = await db
    .from('oracle_payments')
    .select('*')
    .eq('status', 'pending')
    .limit(50)

  if (!pending || pending.length === 0) {
    return { paid: 0, skipped: 0 }
  }

  let paid = 0
  let skipped = 0

  for (const payment of pending as OraclePaymentRow[]) {
    // Look up the oracle's agent to get their connected account
    const { data: agent } = await db
      .from('agents')
      .select('*')
      .eq('id', payment.agent_id)
      .single()

    if (!agent) {
      skipped++
      continue
    }

    const agentRow = agent as AgentRow

    if (!agentRow.stripe_connected_account_id || !agentRow.stripe_onboarding_complete) {
      // Agent hasn't completed Connect onboarding — skip, retry next tick
      skipped++
      continue
    }

    try {
      await stripeService.transferToConnectedAccount({
        amountCents: payment.amount_cents,
        connectedAccountId: agentRow.stripe_connected_account_id,
        metadata: {
          type: 'oracle_payout',
          oracle_payment_id: payment.id,
          oracle_task_id: payment.oracle_task_id,
        },
      })

      await db
        .from('oracle_payments')
        .update({ status: 'paid' })
        .eq('id', payment.id)

      paid++
    } catch (e) {
      // Log but don't fail the batch — retry next cron tick
      console.error(`Oracle payout failed for payment ${payment.id}:`, e)
      skipped++
    }
  }

  return { paid, skipped }
}

/** Policy staleness: flag active policies with >5% dispute rate over rolling 30 days (SPEC §3.1.3). */
export async function handlePolicyStaleness(
  env: Env,
): Promise<{ flagged: number }> {
  const db = createDb(env)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  // Get all active policies
  const { data: activePolicies } = await db
    .from('policies')
    .select('id, created_by')
    .eq('status', 'active')

  if (!activePolicies || activePolicies.length === 0) {
    return { flagged: 0 }
  }

  let flagged = 0

  for (const policy of activePolicies) {
    const policyId = policy.id as string

    // Count total completed escrows using this policy in last 30 days
    const { data: totalEscrows } = await db
      .from('escrows')
      .select('id')
      .eq('policy_id', policyId)
      .in('status', ['released', 'failed', 'disputed', 'expired'])
      .gte('created_at', thirtyDaysAgo)

    const totalCount = totalEscrows?.length ?? 0
    if (totalCount < 5) continue // Not enough data to judge — skip

    // Count disputed escrows
    const { data: disputedEscrows } = await db
      .from('escrows')
      .select('id')
      .eq('policy_id', policyId)
      .eq('status', 'disputed')
      .gte('created_at', thirtyDaysAgo)

    const disputeCount = disputedEscrows?.length ?? 0
    const disputeRate = disputeCount / totalCount

    if (disputeRate > 0.05) {
      // Flag as stale
      await db
        .from('policies')
        .update({ status: 'stale' })
        .eq('id', policyId)

      // Notify creator
      await notifyCron(env, policy.created_by as string, 'policy.stale', policyId, {
        disputeRate: Math.round(disputeRate * 100),
        disputeCount,
        totalCount,
      })

      flagged++
    }
  }

  return { flagged }
}

function createOnchainService(env: Env): OnchainService {
  return new RealOnchainService(
    env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    env.ESCROW_FACTORY_ADDRESS ?? '',
    env.GATEWAY_EOA_PRIVATE_KEY ?? env.GATEWAY_PRIVATE_KEY ?? '',
    parseInt(env.BASE_CHAIN_ID ?? '8453', 10),
  )
}
