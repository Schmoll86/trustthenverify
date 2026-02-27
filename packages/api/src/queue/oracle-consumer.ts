/**
 * Queue consumer for oracle dispatch — selects oracles and creates voting task.
 * Per SPEC-v2 §3.5.2.
 */

import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { RealOracleService } from '../lib/oracle-service'
import type { OracleService } from '../lib/oracle-service'
import type { EscrowRow } from '../lib/types'

export interface OracleQueueMessage {
  type: 'oracle_dispatch'
  escrowId: string
  deliverable: Record<string, unknown>
}

export async function handleOracleDispatch(
  message: OracleQueueMessage,
  env: Env,
  oracleService?: OracleService,
): Promise<void> {
  const db = createDb(env)
  const oracle = oracleService ?? new RealOracleService(db, env)

  // Load escrow
  const { data: escrowRow } = await db
    .from('escrows')
    .select('*')
    .eq('id', message.escrowId)
    .single()

  if (!escrowRow) return
  const esc = escrowRow as EscrowRow

  // Only process if escrow is still delivered
  if (esc.status !== 'delivered') return

  const windowSeconds = parseInt(env.ORACLE_VOTING_WINDOW_SECONDS ?? '1800', 10)
  const quorum = 3
  const oracleCount = 5

  // Extract required capabilities from task spec for oracle matching
  const requiredCapabilities = Array.isArray(esc.task_spec?.requiredCapabilities)
    ? esc.task_spec.requiredCapabilities as string[]
    : undefined

  // Select oracles (exclude buyer and seller, filter by capabilities)
  const oracles = await oracle.selectOracles(esc.buyer_id, esc.seller_id, oracleCount, requiredCapabilities)

  if (oracles.length < oracleCount) {
    // Insufficient oracles — fallback to buyer_confirm
    await db
      .from('escrows')
      .update({ verification_method: 'buyer_confirm' })
      .eq('id', message.escrowId)
    return
  }

  // Create oracle task with vote assignments
  await oracle.createTask(
    message.escrowId,
    message.deliverable,
    esc.task_spec ? JSON.stringify(esc.task_spec) : null,
    esc.policy_id,
    oracles,
    windowSeconds,
    quorum,
  )
}
