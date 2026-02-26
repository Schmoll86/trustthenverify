/**
 * Mock OracleService for tests. Records all calls and returns configurable results.
 */

import type { OracleService, ConsensusResult } from '../../lib/oracle-service'
import type { OraclePoolRow, OracleTaskRow, OracleVoteRow } from '../../lib/types'

export interface OracleCall {
  method: string
  params: Record<string, unknown>
}

export function createMockOracle(): OracleService & {
  calls: OracleCall[]
  reset(): void
  setOracles(oracles: OraclePoolRow[]): void
  setConsensusResult(result: ConsensusResult): void
} {
  const calls: OracleCall[] = []
  let counter = 0
  let mockOracles: OraclePoolRow[] = []
  let mockConsensus: ConsensusResult = {
    decided: true,
    consensus: 'pass',
    votesPass: 3,
    votesFail: 0,
  }

  return {
    calls,
    reset() {
      calls.length = 0
      counter = 0
      mockOracles = []
    },
    setOracles(oracles: OraclePoolRow[]) {
      mockOracles = oracles
    },
    setConsensusResult(result: ConsensusResult) {
      mockConsensus = result
    },
    async selectOracles(buyerId, sellerId, count) {
      calls.push({ method: 'selectOracles', params: { buyerId, sellerId, count } })
      return mockOracles.slice(0, count)
    },
    async createTask(escrowId, deliverable, taskSpec, policyId, oracles, windowSeconds, quorum) {
      counter++
      calls.push({
        method: 'createTask',
        params: { escrowId, deliverable, taskSpec, policyId, oracleCount: oracles.length, windowSeconds, quorum },
      })
      return {
        id: `oracle-task-${counter}`,
        escrow_id: escrowId,
        status: 'voting',
        quorum,
        total_oracles: oracles.length,
        consensus: null,
        deliverable,
        task_spec: taskSpec,
        policy_id: policyId,
        votes_pass: 0,
        votes_fail: 0,
        expires_at: new Date(Date.now() + windowSeconds * 1000).toISOString(),
        decided_at: null,
        created_at: new Date().toISOString(),
      } as OracleTaskRow
    },
    async recordVote(oracleTaskId, oracleId, agentId, verdict, rationale) {
      calls.push({ method: 'recordVote', params: { oracleTaskId, oracleId, agentId, verdict, rationale } })
      return {
        task: {
          id: oracleTaskId,
          escrow_id: 'mock-escrow',
          status: mockConsensus.decided ? 'decided' : 'voting',
          quorum: 3,
          total_oracles: 5,
          consensus: mockConsensus.decided ? mockConsensus.consensus : null,
          deliverable: {},
          task_spec: null,
          policy_id: null,
          votes_pass: mockConsensus.votesPass,
          votes_fail: mockConsensus.votesFail,
          expires_at: new Date().toISOString(),
          decided_at: mockConsensus.decided ? new Date().toISOString() : null,
          created_at: new Date().toISOString(),
        } as OracleTaskRow,
        consensus: mockConsensus,
      }
    },
    async finalizeTask(oracleTaskId, consensus) {
      calls.push({ method: 'finalizeTask', params: { oracleTaskId, consensus } })
    },
    async getAssignments(agentId) {
      calls.push({ method: 'getAssignments', params: { agentId } })
      return []
    },
    async getTask(taskId) {
      calls.push({ method: 'getTask', params: { taskId } })
      return null
    },
    async getVotes(taskId) {
      calls.push({ method: 'getVotes', params: { taskId } })
      return []
    },
  }
}
