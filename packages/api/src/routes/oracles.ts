/**
 * Oracle pool + voting routes — per SPEC-v2 §3.5.
 */

import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { snakeToCamel } from '../lib/case'
import { success, error } from '../lib/response'
import type { OracleService } from '../lib/oracle-service'
import { RealOracleService } from '../lib/oracle-service'
import type { OraclePoolRow } from '../lib/types'

type AppEnv = {
  Bindings: Env
  Variables: {
    agentPubkey?: string
    agentId?: string
    sandboxMode?: boolean
    rawBody?: string
    oracle?: OracleService
  }
}

export const oracles = new Hono<AppEnv>()

/** Get or create OracleService. Tests inject via c.set('oracle', mock). */
function getOracle(c: { env: Env; get(key: 'oracle'): OracleService | undefined }): OracleService {
  const injected = c.get('oracle')
  if (injected) return injected
  const db = createDb(c.env)
  return new RealOracleService(db, c.env)
}

/**
 * Resolve agentId for GET requests (which bypass auth middleware).
 * Falls back to reading X-Agent-Pubkey header and looking up the agent.
 */
async function resolveAgentId(c: { env: Env; req: { header(name: string): string | undefined }; get(key: 'agentId'): string | undefined }): Promise<string | null> {
  const fromAuth = c.get('agentId')
  if (fromAuth) return fromAuth

  // For GET requests: resolve from pubkey header
  const pubkey = c.req.header('X-Agent-Pubkey')
  if (!pubkey) return null

  const db = createDb(c.env)
  const { data: agent } = await db
    .from('agents')
    .select('id')
    .eq('public_key', pubkey)
    .single()

  return agent?.id ?? null
}

// ── POST /oracles/join — join oracle pool ──────────────────────────────────

oracles.post('/join', async (c) => {
  const agentId = c.get('agentId')
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const rawBody = c.get('rawBody')
  let body: { capabilities?: string[] }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  const db = createDb(c.env)

  // Check if already in pool
  const { data: existing } = await db
    .from('oracle_pool')
    .select('*')
    .eq('agent_id', agentId)
    .single()

  if (existing) {
    if ((existing as OraclePoolRow).status === 'active') {
      return error(c, 409, 'ALREADY_JOINED', 'Agent is already in the oracle pool')
    }
    // Re-activate withdrawn oracle
    const { data: updated } = await db
      .from('oracle_pool')
      .update({
        status: 'active',
        capabilities: body.capabilities ?? [],
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single()

    return success(c, snakeToCamel(updated ?? existing), 200)
  }

  // New oracle pool entry
  const { data: row, error: dbError } = await db
    .from('oracle_pool')
    .insert({
      agent_id: agentId,
      status: 'active',
      capabilities: body.capabilities ?? [],
    })
    .select()
    .single()

  if (dbError || !row) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to join oracle pool')
  }

  return success(c, snakeToCamel(row), 201)
})

// ── POST /oracles/withdraw — leave oracle pool ────────────────────────────

oracles.post('/withdraw', async (c) => {
  const agentId = c.get('agentId')
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const db = createDb(c.env)

  const { data: existing } = await db
    .from('oracle_pool')
    .select('*')
    .eq('agent_id', agentId)
    .single()

  if (!existing) {
    return error(c, 404, 'NOT_FOUND', 'Agent is not in the oracle pool')
  }

  if ((existing as OraclePoolRow).status === 'withdrawn') {
    return error(c, 409, 'ALREADY_WITHDRAWN', 'Agent has already withdrawn')
  }

  const { data: updated } = await db
    .from('oracle_pool')
    .update({ status: 'withdrawn', updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .select()
    .single()

  return success(c, snakeToCamel(updated ?? existing))
})

// ── GET /oracles/status — own pool stats ──────────────────────────────────

oracles.get('/status', async (c) => {
  const agentId = await resolveAgentId(c)
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const db = createDb(c.env)

  const { data: row } = await db
    .from('oracle_pool')
    .select('*')
    .eq('agent_id', agentId)
    .single()

  if (!row) {
    return error(c, 404, 'NOT_FOUND', 'Agent is not in the oracle pool')
  }

  return success(c, snakeToCamel(row))
})

// ── GET /oracles/tasks — pending vote assignments ─────────────────────────

oracles.get('/tasks', async (c) => {
  const agentId = await resolveAgentId(c)
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const db = createDb(c.env)

  // Get pending votes for this agent with task details
  const { data: votes } = await db
    .from('oracle_votes')
    .select('*')
    .eq('agent_id', agentId)
    .eq('status', 'pending')

  if (!votes || votes.length === 0) {
    return success(c, [])
  }

  // Fetch associated tasks
  const taskIds = [...new Set(votes.map((v: Record<string, unknown>) => v.oracle_task_id as string))]
  const { data: tasks } = await db
    .from('oracle_tasks')
    .select('*')
    .in('id', taskIds)

  const taskMap = new Map((tasks ?? []).map((t: Record<string, unknown>) => [t.id, t]))

  const assignments = votes.map((v: Record<string, unknown>) => ({
    ...snakeToCamel<Record<string, unknown>>(v),
    oracleTask: snakeToCamel<Record<string, unknown>>(taskMap.get(v.oracle_task_id as string) ?? {}),
  }))

  return success(c, assignments)
})

// ── POST /oracles/vote — submit verdict ───────────────────────────────────

oracles.post('/vote', async (c) => {
  const agentId = c.get('agentId')
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const rawBody = c.get('rawBody')
  let body: { oracleTaskId: string; verdict: string; rationale?: string }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  if (!body.oracleTaskId) {
    return error(c, 400, 'INVALID_PARAMS', 'oracleTaskId is required')
  }
  if (body.verdict !== 'pass' && body.verdict !== 'fail') {
    return error(c, 400, 'INVALID_PARAMS', 'verdict must be "pass" or "fail"')
  }

  const db = createDb(c.env)

  // Find the oracle pool entry for this agent
  const { data: poolEntry } = await db
    .from('oracle_pool')
    .select('*')
    .eq('agent_id', agentId)
    .single()

  if (!poolEntry) {
    return error(c, 403, 'FORBIDDEN', 'Agent is not in the oracle pool')
  }

  const oracle = getOracle(c as unknown as { env: Env; get(key: 'oracle'): OracleService | undefined })

  try {
    const { task, consensus } = await oracle.recordVote(
      body.oracleTaskId,
      (poolEntry as OraclePoolRow).id,
      agentId,
      body.verdict as 'pass' | 'fail',
      body.rationale ?? null,
    )

    // If consensus reached, finalize
    if (consensus.decided) {
      await oracle.finalizeTask(body.oracleTaskId, consensus.consensus)
    }

    return success(c, {
      voted: true,
      verdict: body.verdict,
      consensus: consensus.decided ? consensus.consensus : null,
      task: snakeToCamel(task),
    })
  } catch (err) {
    const msg = (err as Error).message
    if (msg.includes('not voting') || msg.includes('already')) {
      return error(c, 409, 'INVALID_STATE', msg)
    }
    if (msg.includes('cannot vote on own')) {
      return error(c, 403, 'FORBIDDEN', msg)
    }
    return error(c, 500, 'INTERNAL_ERROR', msg)
  }
})

// ── GET /oracles/earnings — accumulated oracle earnings ──────────────────

oracles.get('/earnings', async (c) => {
  const agentId = await resolveAgentId(c)
  if (!agentId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const db = createDb(c.env)

  // Get oracle pool entry
  const { data: poolEntry } = await db
    .from('oracle_pool')
    .select('id')
    .eq('agent_id', agentId)
    .single()

  if (!poolEntry) {
    return error(c, 404, 'NOT_FOUND', 'Agent is not in the oracle pool')
  }

  // Sum earnings by status
  const { data: payments } = await db
    .from('oracle_payments')
    .select('amount_cents, status, funded_by')
    .eq('oracle_id', poolEntry.id)

  const earnings = {
    totalCents: 0,
    pendingCents: 0,
    paidCents: 0,
    paymentCount: 0,
  }

  if (payments) {
    for (const p of payments) {
      earnings.totalCents += p.amount_cents
      earnings.paymentCount++
      if (p.status === 'paid') {
        earnings.paidCents += p.amount_cents
      } else {
        earnings.pendingCents += p.amount_cents
      }
    }
  }

  return success(c, earnings)
})

// ── GET /oracles/task/:id — public task status ────────────────────────────

oracles.get('/task/:id', async (c) => {
  const taskId = c.req.param('id')
  const db = createDb(c.env)

  const { data: task } = await db
    .from('oracle_tasks')
    .select('*')
    .eq('id', taskId)
    .single()

  if (!task) {
    return error(c, 404, 'NOT_FOUND', `Oracle task not found: ${taskId}`)
  }

  // Get votes (without rationale for non-participants)
  const { data: votes } = await db
    .from('oracle_votes')
    .select('*')
    .eq('oracle_task_id', taskId)

  return success(c, {
    ...snakeToCamel<Record<string, unknown>>(task),
    votes: (votes ?? []).map((v: Record<string, unknown>) => ({
      id: v.id,
      status: v.status,
      verdict: v.verdict,
      submittedAt: v.submitted_at,
    })),
  })
})
