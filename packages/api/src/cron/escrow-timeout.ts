/**
 * Cron handler: sweep expired escrows + check on-chain funding.
 * Runs on Cloudflare Workers scheduled event.
 */

import { createDb, type Env } from '../lib/db'
import { RealStripeService } from '../lib/stripe'
import type { StripeService } from '../lib/stripe'
import type { OnchainService } from '../lib/onchain'
import { RealOnchainService } from '../lib/onchain'
import type { EscrowRow, OracleTaskRow } from '../lib/types'
import { RealOracleService } from '../lib/oracle-service'
import type { OracleService } from '../lib/oracle-service'
import { checkConsensus } from '../lib/oracle-service'

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

function createOnchainService(env: Env): OnchainService {
  return new RealOnchainService(
    env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    env.ESCROW_FACTORY_ADDRESS ?? '',
    env.GATEWAY_EOA_PRIVATE_KEY ?? '',
    parseInt(env.BASE_CHAIN_ID ?? '8453', 10),
  )
}
