/**
 * Cron handler: sweep expired escrows.
 * Runs on Cloudflare Workers scheduled event.
 */

import { createDb, type Env } from '../lib/db'
import { RealStripeService } from '../lib/stripe'
import type { StripeService } from '../lib/stripe'
import type { EscrowRow } from '../lib/types'

export async function handleEscrowTimeout(
  env: Env,
  stripe?: StripeService,
): Promise<{ processed: number }> {
  const db = createDb(env)
  const stripeService = stripe ?? new RealStripeService(env.STRIPE_SECRET_KEY)
  const now = new Date().toISOString()

  // Query escrows that are proposed or active and past their expiry
  const { data: expired } = await db
    .from('escrows')
    .select('*')
    .in('status', ['proposed', 'active'])
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
    } else if (row.status === 'active') {
      // Refund buyer, burn seller collateral
      if (row.stripe_escrow_id) {
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
