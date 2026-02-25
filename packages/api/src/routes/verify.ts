import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { snakeToCamel } from '../lib/case'
import { success, error } from '../lib/response'
import type { VerificationResult } from '@trustthenverify/sdk'

type AppEnv = { Bindings: Env }

export const verify = new Hono<AppEnv>()

// GET /verify/:escrow_id — latest verification result for an escrow (public)
verify.get('/:escrow_id', async (c) => {
  const escrowId = c.req.param('escrow_id')
  const db = createDb(c.env)

  const { data: rows } = await db
    .from('verifications')
    .select('*')
    .eq('escrow_id', escrowId)
    .order('verified_at', { ascending: false })
    .limit(1)

  if (!rows || rows.length === 0) {
    return error(c, 404, 'NOT_FOUND', `No verification found for escrow: ${escrowId}`)
  }

  return success(c, snakeToCamel<VerificationResult>(rows[0] as Record<string, unknown>))
})
