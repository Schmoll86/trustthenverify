/**
 * Cron handler: sweep expired escrows + check on-chain funding.
 * Runs on Cloudflare Workers scheduled event.
 */

import { createDb, type Env } from '../lib/db'
import { RealStripeService } from '../lib/stripe'
import type { StripeService } from '../lib/stripe'
import type { OnchainService } from '../lib/onchain'
import { RealOnchainService } from '../lib/onchain'
import type { EscrowRow } from '../lib/types'

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
      } else if (row.stripe_escrow_id) {
        await stripeService.refundBuyerAndBurnCollateral({
          stripeEscrowId: row.stripe_escrow_id,
          buyerRefundCents: row.amount_cents,
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

function createOnchainService(env: Env): OnchainService {
  return new RealOnchainService(
    env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    env.ESCROW_FACTORY_ADDRESS ?? '',
    env.GATEWAY_EOA_PRIVATE_KEY ?? '',
    parseInt(env.BASE_CHAIN_ID ?? '8453', 10),
  )
}
