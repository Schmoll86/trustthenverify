import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { snakeToCamel } from '../lib/case'
import { success, error } from '../lib/response'
import { validateFormalSpec } from '../lib/validate-formal-spec'
import { canTransitionPolicy, nextPolicyStatus } from '../lib/policy-state'
import { RealLLMService } from '../lib/openrouter'
import { translatePolicy } from '../lib/translation-service'
import type { Policy, CoverageMap } from '@trustthenverify/sdk'
import type { PolicyRow } from '../lib/types'

const DEFAULT_TRANSLATOR_MODEL = 'moonshotai/kimi-k2.5'
const DEFAULT_CROSS_VALIDATOR_MODEL = 'google/gemini-2.5-flash'

type AppEnv = {
  Bindings: Env
  Variables: {
    agentPubkey?: string
    agentId?: string
    sandboxMode?: boolean
    rawBody?: string
  }
}

export const policies = new Hono<AppEnv>()

// GET /policies/templates — browse pre-refined policy templates
policies.get('/templates', async (c) => {
  const db = createDb(c.env)

  const { data: rows, error: dbError } = await db
    .from('policies')
    .select('*')
    .eq('status', 'active')
    .eq('billing', 'platform')
    .order('name', { ascending: true })

  if (dbError) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to fetch policy templates')
  }

  const templates = (rows || []).map((r: Record<string, unknown>) => snakeToCamel<Policy>(r))

  return c.json({
    data: templates,
    meta: {
      requestId: crypto.randomUUID(),
      count: templates.length,
    },
  })
})

// POST /policies — create policy
policies.post('/', async (c) => {
  const callerId = c.get('agentId')
  if (!callerId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const rawBody = c.get('rawBody')
  let body: {
    name: string
    intent: string
    description?: string
    formalSpec?: Record<string, unknown>
    clauses?: Array<{ index: number; text: string }>
    billing?: string
  }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  if (!body.name || typeof body.name !== 'string') {
    return error(c, 400, 'INVALID_PARAMS', 'name is required')
  }
  if (!body.intent || typeof body.intent !== 'string') {
    return error(c, 400, 'INVALID_PARAMS', 'intent is required')
  }

  // Validate formal_spec if provided
  let status = 'draft'
  let finalFormalSpec: Record<string, unknown> = body.formalSpec ?? { version: 1, constraints: [] }
  let translationModel: string | null = null
  let crossValidator: string | null = null
  let crossValidation: Record<string, unknown> | null = null
  let tier2Used = false
  let translatedClauses: Array<{ index: number; text: string; constraint_ids: string[]; status: string }> | null = null

  if (body.formalSpec) {
    // Manual spec provided — validate directly, skip translation
    const validation = validateFormalSpec(body.formalSpec)
    if (!validation.valid) {
      return error(c, 400, 'INVALID_FORMAL_SPEC', validation.errors.join('; '))
    }
    status = 'validated'
  } else if (c.env.OPENROUTER_API_KEY) {
    // No formalSpec + API key → auto-translate
    const llm = new RealLLMService(c.env.OPENROUTER_API_KEY)
    const tModel = c.env.TRANSLATOR_MODEL ?? DEFAULT_TRANSLATOR_MODEL
    const cvModel = c.env.CROSS_VALIDATOR_MODEL ?? DEFAULT_CROSS_VALIDATOR_MODEL

    const result = await translatePolicy({
      intent: body.intent,
      clauses: body.clauses,
      llm,
      translatorModel: tModel,
      crossValidatorModel: cvModel,
    })

    status = result.status
    finalFormalSpec = result.formalSpec
    translationModel = result.translationModel
    crossValidator = result.crossValidatorModel
    crossValidation = result.crossValidation as Record<string, unknown> | null
    tier2Used = result.tier2Used
    translatedClauses = result.clauses
  }
  // else: no formalSpec + no API key → draft with empty spec (graceful degradation)

  const db = createDb(c.env)

  const insertData: Record<string, unknown> = {
    name: body.name,
    intent: body.intent,
    description: body.description ?? null,
    formal_spec: finalFormalSpec,
    version: 1,
    status,
    billing: body.billing ?? 'creator',
    tier2_used: tier2Used,
    translation_model: translationModel,
    cross_validator: crossValidator,
    cross_validation: crossValidation,
    created_by: callerId,
  }

  const { data: row, error: dbError } = await db
    .from('policies')
    .insert(insertData)
    .select()
    .single()

  if (dbError || !row) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create policy')
  }

  const policyRow = row as PolicyRow

  // Insert coverage rows from translation result
  if (translatedClauses && translatedClauses.length > 0) {
    for (const clause of translatedClauses) {
      await db.from('policy_coverage').insert({
        policy_id: policyRow.id,
        clause_index: clause.index,
        clause_text: clause.text,
        constraint_ids: clause.constraint_ids,
        status: clause.status,
        note: null,
      })
    }
  } else if (body.clauses && body.clauses.length > 0 && body.formalSpec) {
    // Manual spec with clauses — existing behavior
    const constraints = (body.formalSpec as { constraints?: Array<{ clauseRef?: string; id: string }> }).constraints ?? []
    for (const clause of body.clauses) {
      const matchedIds = constraints
        .filter(con => con.clauseRef === String(clause.index))
        .map(con => con.id)
      await db.from('policy_coverage').insert({
        policy_id: policyRow.id,
        clause_index: clause.index,
        clause_text: clause.text,
        constraint_ids: matchedIds,
        status: matchedIds.length > 0 ? 'covered' : 'uncovered',
        note: null,
      })
    }
  }

  return success(c, snakeToCamel<Policy>(row), 201)
})

// GET /policies/:id — get policy with formal spec
policies.get('/:id', async (c) => {
  const id = c.req.param('id')
  const db = createDb(c.env)

  const { data: row } = await db
    .from('policies')
    .select('*')
    .eq('id', id)
    .single()

  if (!row) {
    return error(c, 404, 'NOT_FOUND', `Policy not found: ${id}`)
  }

  return success(c, snakeToCamel<Policy>(row))
})

// POST /policies/:id/revise — update intent/spec
policies.post('/:id/revise', async (c) => {
  const id = c.req.param('id')
  const callerId = c.get('agentId')
  if (!callerId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const rawBody = c.get('rawBody')
  let body: { intent?: string; formalSpec?: Record<string, unknown> }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  const db = createDb(c.env)

  const { data: row } = await db
    .from('policies')
    .select('*')
    .eq('id', id)
    .single()

  if (!row) {
    return error(c, 404, 'NOT_FOUND', `Policy not found: ${id}`)
  }

  const policy = row as PolicyRow

  if (policy.created_by !== callerId) {
    return error(c, 403, 'FORBIDDEN', 'Only the creator can revise this policy')
  }

  if (policy.status === 'active' || policy.status === 'deprecated') {
    return error(c, 409, 'INVALID_STATE', `Cannot revise policy in status: ${policy.status}`)
  }

  const updates: Record<string, unknown> = {}

  if (body.intent) updates.intent = body.intent

  if (body.formalSpec) {
    // Manual spec provided — validate directly
    const validation = validateFormalSpec(body.formalSpec)
    if (!validation.valid) {
      return error(c, 400, 'INVALID_FORMAL_SPEC', validation.errors.join('; '))
    }
    updates.formal_spec = body.formalSpec
    updates.status = 'validated'
  } else if (body.intent && c.env.OPENROUTER_API_KEY) {
    // Intent changed + API key → re-translate
    const llm = new RealLLMService(c.env.OPENROUTER_API_KEY)
    const tModel = c.env.TRANSLATOR_MODEL ?? DEFAULT_TRANSLATOR_MODEL
    const cvModel = c.env.CROSS_VALIDATOR_MODEL ?? DEFAULT_CROSS_VALIDATOR_MODEL

    const result = await translatePolicy({
      intent: body.intent,
      llm,
      translatorModel: tModel,
      crossValidatorModel: cvModel,
    })

    updates.formal_spec = result.formalSpec
    updates.status = result.status
    updates.translation_model = result.translationModel
    updates.cross_validator = result.crossValidatorModel
    updates.cross_validation = result.crossValidation
    updates.tier2_used = result.tier2Used

    // Rebuild coverage rows
    if (result.clauses.length > 0) {
      await db.from('policy_coverage').delete().eq('policy_id', id)
      for (const clause of result.clauses) {
        await db.from('policy_coverage').insert({
          policy_id: id,
          clause_index: clause.index,
          clause_text: clause.text,
          constraint_ids: clause.constraint_ids,
          status: clause.status,
          note: null,
        })
      }
    }
  } else if (body.intent) {
    // Intent changed but no API key — reset to draft
    updates.status = 'draft'
  }

  if (Object.keys(updates).length === 0) {
    return error(c, 400, 'INVALID_PARAMS', 'Nothing to update')
  }

  const { data: updated } = await db
    .from('policies')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (!updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to update policy')
  }

  return success(c, snakeToCamel<Policy>(updated))
})

// POST /policies/:id/activate — activate policy
policies.post('/:id/activate', async (c) => {
  const id = c.req.param('id')
  const callerId = c.get('agentId')
  if (!callerId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const db = createDb(c.env)

  const { data: row } = await db
    .from('policies')
    .select('*')
    .eq('id', id)
    .single()

  if (!row) {
    return error(c, 404, 'NOT_FOUND', `Policy not found: ${id}`)
  }

  const policy = row as PolicyRow

  if (policy.created_by !== callerId) {
    return error(c, 403, 'FORBIDDEN', 'Only the creator can activate this policy')
  }

  const currentStatus = policy.status as 'validated' | 'approved'
  if (!canTransitionPolicy(currentStatus, 'activate')) {
    return error(c, 409, 'INVALID_STATE', `Cannot activate policy in status: ${policy.status}`)
  }

  const now = new Date().toISOString()

  const { data: updated } = await db
    .from('policies')
    .update({
      status: nextPolicyStatus(currentStatus, 'activate'),
      activated_at: now,
    })
    .eq('id', id)
    .select()
    .single()

  // Deprecate parent if exists
  if (policy.parent_version) {
    await db
      .from('policies')
      .update({
        status: 'deprecated',
        deprecated_at: now,
      })
      .eq('id', policy.parent_version)
  }

  if (!updated) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to activate policy')
  }

  return success(c, snakeToCamel<Policy>(updated))
})

// POST /policies/:id/refine — trigger Argus Codex (Phase 3)
policies.post('/:id/refine', async (c) => {
  const id = c.req.param('id')
  const callerId = c.get('agentId')
  if (!callerId) {
    return error(c, 401, 'UNAUTHORIZED', 'Authentication required')
  }

  const rawBody = c.get('rawBody')
  let body: { budget?: number }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_PARAMS', 'Invalid JSON body')
  }

  const db = createDb(c.env)

  const { data: row } = await db
    .from('policies')
    .select('*')
    .eq('id', id)
    .single()

  if (!row) {
    return error(c, 404, 'NOT_FOUND', `Policy not found: ${id}`)
  }

  const policy = row as PolicyRow

  if (policy.created_by !== callerId) {
    return error(c, 403, 'FORBIDDEN', 'Only the creator can refine this policy')
  }

  if (policy.status !== 'validated') {
    return error(c, 409, 'INVALID_STATE', `Policy must be validated to refine, current: ${policy.status}`)
  }

  // Check no running refinement exists
  const { data: existing } = await db
    .from('refinements')
    .select('*')
    .eq('policy_id', id)
    .eq('status', 'running')

  if (existing && (existing as unknown[]).length > 0) {
    return error(c, 409, 'REFINEMENT_IN_PROGRESS', 'A refinement is already running for this policy')
  }

  const budget = body.budget ?? 1000

  // Create refinement row
  const { data: refRow, error: dbError } = await db
    .from('refinements')
    .insert({
      policy_id: id,
      status: 'running',
      budget,
      current_round: 0,
      last_exploit_round: 0,
      consecutive_clean: 0,
      working_spec: policy.formal_spec,
      exploits: [],
      tier2_introduced: false,
    })
    .select()
    .single()

  if (dbError || !refRow) {
    return error(c, 500, 'INTERNAL_ERROR', 'Failed to create refinement')
  }

  const refinement = refRow as { id: string; status: string }

  // Enqueue first batch
  await c.env.QUEUE.send({
    type: 'argus_refine',
    refinementId: refinement.id,
    policyId: id,
  })

  return c.json({
    data: { refinementId: refinement.id, status: 'running' },
    meta: { requestId: crypto.randomUUID() },
  }, 202)
})

// GET /policies/:id/refine/status
policies.get('/:id/refine/status', async (c) => {
  const id = c.req.param('id')
  const db = createDb(c.env)

  // Get latest refinement for this policy
  const { data: rows } = await db
    .from('refinements')
    .select('*')
    .eq('policy_id', id)
    .order('created_at', { ascending: false })
    .limit(1)

  if (!rows || (rows as unknown[]).length === 0) {
    return error(c, 404, 'NOT_FOUND', 'No refinement found for this policy')
  }

  const refinement = (rows as unknown[])[0] as {
    id: string
    status: string
    exploits: unknown[]
    coverage: number | null
    current_round: number
    budget: number
    policy_id: string
  }

  return success(c, {
    refinementId: refinement.id,
    status: refinement.status,
    exploitsFound: refinement.exploits ? refinement.exploits.length : 0,
    coverageEstimate: refinement.coverage,
    currentRound: refinement.current_round,
    budget: refinement.budget,
    policyId: refinement.policy_id,
  })
})

// GET /policies/:id/coverage — get coverage map
policies.get('/:id/coverage', async (c) => {
  const id = c.req.param('id')
  const db = createDb(c.env)

  const { data: rows } = await db
    .from('policy_coverage')
    .select('*')
    .eq('policy_id', id)
    .order('clause_index', { ascending: true })

  if (!rows || rows.length === 0) {
    return success(c, { clauses: [], uncoveredCount: 0 } as CoverageMap)
  }

  const clauses = (rows as Array<Record<string, unknown>>).map((r) => ({
    index: r.clause_index as number,
    text: r.clause_text as string,
    constraintIds: r.constraint_ids as string[],
    status: r.status as string,
    note: r.note as string | null,
  }))

  const uncoveredCount = clauses.filter(cl => cl.status === 'uncovered').length

  return success(c, { clauses, uncoveredCount })
})
