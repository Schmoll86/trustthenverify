/**
 * Queue consumer for Argus Codex async refinement.
 * Processes batches of 10 rounds per message, self-chains until done.
 */

import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { RealAIService } from '../lib/workers-ai'
import { runArgusBatch, computeCoverage, shouldAutoApprove } from '../lib/argus-engine'
import type { RefinementRow, PolicyRow } from '../lib/types'

export interface ArgusQueueMessage {
  type: 'argus_refine'
  refinementId: string
  policyId: string
}

export async function handleArgusMessage(
  message: ArgusQueueMessage,
  env: Env,
): Promise<void> {
  const db = createDb(env)

  // Load refinement row
  const { data: refRow } = await db
    .from('refinements')
    .select('*')
    .eq('id', message.refinementId)
    .single()

  if (!refRow) return
  const refinement = refRow as RefinementRow

  // Idempotency: skip if not running
  if (refinement.status !== 'running') return

  // Load policy for intent
  const { data: polRow } = await db
    .from('policies')
    .select('*')
    .eq('id', message.policyId)
    .single()

  if (!polRow) {
    await db.from('refinements').update({
      status: 'failed',
      error_message: 'Policy not found',
      completed_at: new Date().toISOString(),
    }).eq('id', refinement.id)
    return
  }

  const policy = polRow as PolicyRow
  const ai = new RealAIService(env.AI)

  // Build state from refinement row
  const state = {
    workingSpec: refinement.working_spec,
    currentRound: refinement.current_round,
    lastExploitRound: refinement.last_exploit_round,
    consecutiveClean: refinement.consecutive_clean,
    exploits: (refinement.exploits || []) as Array<{ round: number; exploit: Record<string, unknown>; explanation: string }>,
    tier2Introduced: refinement.tier2_introduced,
    budget: refinement.budget,
  }

  let result
  try {
    result = await runArgusBatch(policy.intent, state, ai)
  } catch (err) {
    await db.from('refinements').update({
      status: 'failed',
      error_message: (err as Error).message,
      completed_at: new Date().toISOString(),
    }).eq('id', refinement.id)
    return
  }

  const { state: newState, done } = result

  if (done) {
    // Compute final coverage
    const coverage = computeCoverage(newState.currentRound, newState.lastExploitRound)
    const autoApprove = shouldAutoApprove(coverage, newState.tier2Introduced)

    // Update refinement row
    await db.from('refinements').update({
      status: 'complete',
      current_round: newState.currentRound,
      last_exploit_round: newState.lastExploitRound,
      consecutive_clean: newState.consecutiveClean,
      working_spec: newState.workingSpec,
      exploits: newState.exploits,
      coverage,
      tier2_introduced: newState.tier2Introduced,
      completed_at: new Date().toISOString(),
    }).eq('id', refinement.id)

    // Update policy with argus results
    const policyUpdates: Record<string, unknown> = {
      argus_coverage: coverage,
      argus_exploits: newState.exploits,
      argus_budget: newState.currentRound,
      tier2_used: newState.tier2Introduced,
      formal_spec: newState.workingSpec,
    }

    if (autoApprove) {
      policyUpdates.status = 'approved'
    }

    await db.from('policies').update(policyUpdates).eq('id', policy.id)

    // If Tier 2 introduced, create new policy version with parent linkage
    if (newState.tier2Introduced) {
      await db.from('policies').insert({
        name: policy.name,
        description: policy.description,
        intent: policy.intent,
        formal_spec: newState.workingSpec,
        version: policy.version + 1,
        status: autoApprove ? 'approved' : 'validated',
        billing: policy.billing,
        tier2_used: true,
        parent_version: policy.id,
        created_by: policy.created_by,
      })
    }
  } else {
    // Update refinement with progress, re-enqueue
    await db.from('refinements').update({
      current_round: newState.currentRound,
      last_exploit_round: newState.lastExploitRound,
      consecutive_clean: newState.consecutiveClean,
      working_spec: newState.workingSpec,
      exploits: newState.exploits,
      tier2_introduced: newState.tier2Introduced,
    }).eq('id', refinement.id)

    // Self-chain: enqueue next batch
    await env.QUEUE.send({
      type: 'argus_refine',
      refinementId: refinement.id,
      policyId: policy.id,
    })
  }
}
