/**
 * Oracle consensus verification service — selects oracles, manages tasks/votes,
 * checks consensus, and finalizes results. Per SPEC-v2 §3.5.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from './db'
import type { OracleTaskRow, OracleVoteRow, OraclePoolRow } from './types'

// ─── Consensus logic (pure, exported for unit testing) ───

export interface ConsensusResult {
  decided: boolean
  consensus: 'pass' | 'fail' | 'no_consensus'
  votesPass: number
  votesFail: number
}

/**
 * Check if consensus has been reached given current vote tallies.
 * Early termination: returns decided=true as soon as quorum votes agree.
 * Called after each vote and on timeout sweep.
 */
export function checkConsensus(
  votesPass: number,
  votesFail: number,
  quorum: number,
  totalOracles: number,
): ConsensusResult {
  if (votesPass >= quorum) {
    return { decided: true, consensus: 'pass', votesPass, votesFail }
  }
  if (votesFail >= quorum) {
    return { decided: true, consensus: 'fail', votesPass, votesFail }
  }
  // All voted but no quorum (shouldn't happen with 5 binary votes and quorum 3,
  // but handle for safety with configurable values)
  const totalVoted = votesPass + votesFail
  if (totalVoted >= totalOracles) {
    // All voted, pick majority
    const consensus = votesPass > votesFail ? 'pass' as const
      : votesFail > votesPass ? 'fail' as const
      : 'no_consensus' as const
    return { decided: true, consensus, votesPass, votesFail }
  }
  // Not enough votes yet — check if quorum is still reachable
  const remaining = totalOracles - totalVoted
  if (votesPass + remaining < quorum && votesFail + remaining < quorum) {
    // Neither side can reach quorum even if all remaining votes go one way
    return { decided: true, consensus: 'no_consensus', votesPass, votesFail }
  }
  return { decided: false, consensus: 'no_consensus', votesPass, votesFail }
}

// ─── Service interface ───

export interface OracleService {
  /** Select eligible oracles, excluding buyer/seller. Returns oracle pool IDs. */
  selectOracles(buyerId: string, sellerId: string, count: number): Promise<OraclePoolRow[]>

  /** Create an oracle task with vote assignments. Returns the task row. */
  createTask(
    escrowId: string,
    deliverable: Record<string, unknown>,
    taskSpec: string | null,
    policyId: string | null,
    oracles: OraclePoolRow[],
    windowSeconds: number,
    quorum: number,
  ): Promise<OracleTaskRow>

  /** Record an oracle's vote. Returns updated task if consensus reached. */
  recordVote(
    oracleTaskId: string,
    oracleId: string,
    agentId: string,
    verdict: 'pass' | 'fail',
    rationale: string | null,
  ): Promise<{ task: OracleTaskRow; consensus: ConsensusResult }>

  /** Finalize a decided task — update escrow, create verification + payment records. */
  finalizeTask(oracleTaskId: string, consensus: 'pass' | 'fail' | 'no_consensus'): Promise<void>

  /** Get pending vote assignments for an agent. */
  getAssignments(agentId: string): Promise<Array<OracleVoteRow & { oracle_task: OracleTaskRow }>>

  /** Get task by ID. */
  getTask(taskId: string): Promise<OracleTaskRow | null>

  /** Get votes for a task. */
  getVotes(taskId: string): Promise<OracleVoteRow[]>
}

// ─── Implementation ───

export class RealOracleService implements OracleService {
  private db: SupabaseClient
  private env: Env

  constructor(db: SupabaseClient, env: Env) {
    this.db = db
    this.env = env
  }

  async selectOracles(buyerId: string, sellerId: string, count: number): Promise<OraclePoolRow[]> {
    // Get active oracles excluding buyer and seller
    const { data, error } = await this.db
      .from('oracle_pool')
      .select('*')
      .eq('status', 'active')

    if (error) throw new Error(`Failed to query oracle pool: ${error.message}`)
    if (!data) return []

    // Filter out buyer and seller
    const eligible = (data as OraclePoolRow[]).filter(
      (o) => o.agent_id !== buyerId && o.agent_id !== sellerId,
    )

    // Random selection
    const shuffled = eligible.sort(() => Math.random() - 0.5)
    return shuffled.slice(0, count)
  }

  async createTask(
    escrowId: string,
    deliverable: Record<string, unknown>,
    taskSpec: string | null,
    policyId: string | null,
    oracles: OraclePoolRow[],
    windowSeconds: number,
    quorum: number,
  ): Promise<OracleTaskRow> {
    const expiresAt = new Date(Date.now() + windowSeconds * 1000).toISOString()

    // Insert oracle task
    const { data: task, error: taskError } = await this.db
      .from('oracle_tasks')
      .insert({
        escrow_id: escrowId,
        status: 'voting',
        quorum,
        total_oracles: oracles.length,
        deliverable,
        task_spec: taskSpec,
        policy_id: policyId,
        expires_at: expiresAt,
      })
      .select()
      .single()

    if (taskError || !task) throw new Error(`Failed to create oracle task: ${taskError?.message}`)

    // Insert vote assignments
    const voteRows = oracles.map((o) => ({
      oracle_task_id: task.id,
      oracle_id: o.id,
      agent_id: o.agent_id,
      status: 'pending',
    }))

    const { error: votesError } = await this.db
      .from('oracle_votes')
      .insert(voteRows)

    if (votesError) throw new Error(`Failed to create vote assignments: ${votesError.message}`)

    return task as OracleTaskRow
  }

  async recordVote(
    oracleTaskId: string,
    oracleId: string,
    agentId: string,
    verdict: 'pass' | 'fail',
    rationale: string | null,
  ): Promise<{ task: OracleTaskRow; consensus: ConsensusResult }> {
    // Verify task is still voting
    const { data: task, error: taskErr } = await this.db
      .from('oracle_tasks')
      .select('*')
      .eq('id', oracleTaskId)
      .single()

    if (taskErr || !task) throw new Error('Oracle task not found')
    if (task.status !== 'voting') {
      throw new Error(`Oracle task is ${task.status}, not voting`)
    }

    // Verify this oracle has a pending assignment
    const { data: vote, error: voteErr } = await this.db
      .from('oracle_votes')
      .select('*')
      .eq('oracle_task_id', oracleTaskId)
      .eq('oracle_id', oracleId)
      .single()

    if (voteErr || !vote) throw new Error('No vote assignment found for this oracle')
    if (vote.status !== 'pending') {
      throw new Error(`Vote already ${vote.status}`)
    }

    // Belt-and-suspenders: reject if oracle is buyer/seller
    const { data: escrow } = await this.db
      .from('escrows')
      .select('buyer_id, seller_id')
      .eq('id', task.escrow_id)
      .single()

    if (escrow && (escrow.buyer_id === agentId || escrow.seller_id === agentId)) {
      throw new Error('Oracle cannot vote on own escrow')
    }

    // Record vote
    const { error: updateErr } = await this.db
      .from('oracle_votes')
      .update({
        status: 'submitted',
        verdict,
        rationale,
        submitted_at: new Date().toISOString(),
      })
      .eq('id', vote.id)

    if (updateErr) throw new Error(`Failed to record vote: ${updateErr.message}`)

    // Update task tallies
    const newPass = task.votes_pass + (verdict === 'pass' ? 1 : 0)
    const newFail = task.votes_fail + (verdict === 'fail' ? 1 : 0)

    const { error: tallyErr } = await this.db
      .from('oracle_tasks')
      .update({ votes_pass: newPass, votes_fail: newFail })
      .eq('id', oracleTaskId)

    if (tallyErr) throw new Error(`Failed to update tallies: ${tallyErr.message}`)

    // Check consensus
    const result = checkConsensus(newPass, newFail, task.quorum, task.total_oracles)

    if (result.decided) {
      // Mark task as decided
      await this.db
        .from('oracle_tasks')
        .update({
          status: 'decided',
          consensus: result.consensus,
          decided_at: new Date().toISOString(),
          votes_pass: newPass,
          votes_fail: newFail,
        })
        .eq('id', oracleTaskId)

      // Expire remaining pending votes
      await this.db
        .from('oracle_votes')
        .update({ status: 'expired' })
        .eq('oracle_task_id', oracleTaskId)
        .eq('status', 'pending')
    }

    const updatedTask: OracleTaskRow = {
      ...task,
      votes_pass: newPass,
      votes_fail: newFail,
      status: result.decided ? 'decided' : task.status,
      consensus: result.decided ? result.consensus : task.consensus,
      decided_at: result.decided ? new Date().toISOString() : task.decided_at,
    }

    return { task: updatedTask, consensus: result }
  }

  async finalizeTask(oracleTaskId: string, consensus: 'pass' | 'fail' | 'no_consensus'): Promise<void> {
    const { data: task, error: taskErr } = await this.db
      .from('oracle_tasks')
      .select('*')
      .eq('id', oracleTaskId)
      .single()

    if (taskErr || !task) throw new Error('Oracle task not found')

    const feeCents = parseInt(this.env.ORACLE_FEE_CENTS ?? '100', 10)

    // Get all submitted votes for payment
    const { data: votes } = await this.db
      .from('oracle_votes')
      .select('*')
      .eq('oracle_task_id', oracleTaskId)
      .eq('status', 'submitted')

    // Create payment records for all oracles who voted
    if (votes && votes.length > 0) {
      const payments = votes.map((v: OracleVoteRow) => ({
        oracle_task_id: oracleTaskId,
        oracle_id: v.oracle_id,
        agent_id: v.agent_id,
        amount_cents: feeCents,
        status: 'pending',
      }))

      await this.db.from('oracle_payments').insert(payments)
    }

    // Update oracle accuracy stats
    if (votes && consensus !== 'no_consensus') {
      for (const v of votes as OracleVoteRow[]) {
        const aligned = v.verdict === consensus
        // Fetch current stats
        const { data: pool } = await this.db
          .from('oracle_pool')
          .select('tasks_completed, accuracy_score')
          .eq('id', v.oracle_id)
          .single()

        if (pool) {
          const newCompleted = pool.tasks_completed + 1
          // Running average: (old * n + new) / (n + 1)
          const newAccuracy = (pool.accuracy_score * pool.tasks_completed + (aligned ? 1 : 0)) / newCompleted
          await this.db
            .from('oracle_pool')
            .update({
              tasks_completed: newCompleted,
              accuracy_score: Math.round(newAccuracy * 10000) / 10000,
              updated_at: new Date().toISOString(),
            })
            .eq('id', v.oracle_id)
        }
      }
    }

    // Create verification record
    const gatewaySignature = `oracle:${oracleTaskId}:${consensus}`
    const verificationResult = consensus === 'pass' ? 'pass'
      : consensus === 'fail' ? 'fail'
      : 'error'

    await this.db.from('verifications').insert({
      escrow_id: task.escrow_id,
      method: 'oracle_consensus',
      policy_id: task.policy_id,
      result: verificationResult,
      constraints_total: task.total_oracles,
      constraints_passed: task.votes_pass,
      failure_details: consensus === 'no_consensus' ? { reason: 'no_consensus', timeout: true } : null,
      proof_hash: null,
      gateway_signature: gatewaySignature,
      verified_at: new Date().toISOString(),
    })

    // Update escrow status based on consensus
    if (consensus === 'pass') {
      await this.db
        .from('escrows')
        .update({ status: 'released', completed_at: new Date().toISOString() })
        .eq('id', task.escrow_id)
    } else if (consensus === 'fail') {
      await this.db
        .from('escrows')
        .update({ status: 'failed', completed_at: new Date().toISOString() })
        .eq('id', task.escrow_id)
    }
    // no_consensus: escrow stays delivered, fallback to buyer_confirm
  }

  async getAssignments(agentId: string): Promise<Array<OracleVoteRow & { oracle_task: OracleTaskRow }>> {
    const { data, error } = await this.db
      .from('oracle_votes')
      .select('*, oracle_task:oracle_tasks(*)')
      .eq('agent_id', agentId)
      .eq('status', 'pending')

    if (error) throw new Error(`Failed to get assignments: ${error.message}`)
    return (data ?? []) as Array<OracleVoteRow & { oracle_task: OracleTaskRow }>
  }

  async getTask(taskId: string): Promise<OracleTaskRow | null> {
    const { data, error } = await this.db
      .from('oracle_tasks')
      .select('*')
      .eq('id', taskId)
      .single()

    if (error) return null
    return data as OracleTaskRow
  }

  async getVotes(taskId: string): Promise<OracleVoteRow[]> {
    const { data, error } = await this.db
      .from('oracle_votes')
      .select('*')
      .eq('oracle_task_id', taskId)

    if (error) throw new Error(`Failed to get votes: ${error.message}`)
    return (data ?? []) as OracleVoteRow[]
  }
}
