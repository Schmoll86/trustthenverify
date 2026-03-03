import { Hono } from 'hono'
import type { Env } from '../lib/db'
import { createDb } from '../lib/db'
import { success, error } from '../lib/response'
import { snakeToCamel } from '../lib/case'
import { buildAttestationEvent, RealNostrService, type NostrService } from '../lib/nostr'
import type { Attestation } from '@trustthenverify/sdk'

// Extended Env allows test injection of NostrService
interface EnvWithNostr extends Env {
  __nostrService?: NostrService
}

type AppEnv = {
  Bindings: EnvWithNostr
  Variables: {
    agentPubkey?: string
    agentId?: string
    sandboxMode?: boolean
    rawBody?: string
  }
}

export const attestations = new Hono<AppEnv>()

const VALID_OUTCOMES = ['success', 'failure', 'timeout', 'partial']

// POST /attestations — publish signed attestation (relayed to Nostr)
attestations.post('/', async (c) => {
  const agentId = c.get('agentId')
  const agentPubkey = c.get('agentPubkey')
  if (!agentId || !agentPubkey) {
    return error(c, 401, 'AUTH_REQUIRED', 'Authentication required')
  }

  const rawBody = c.get('rawBody')
  let body: { subjectId?: string; escrowId?: string; outcome?: string; verificationMethod?: string }
  try {
    body = JSON.parse(rawBody || '{}')
  } catch {
    return error(c, 400, 'INVALID_JSON', 'Invalid JSON body')
  }

  const { subjectId, escrowId, outcome, verificationMethod } = body

  if (!subjectId) {
    return error(c, 400, 'MISSING_FIELD', 'subjectId is required')
  }
  if (!outcome) {
    return error(c, 400, 'MISSING_FIELD', 'outcome is required')
  }
  if (!VALID_OUTCOMES.includes(outcome)) {
    return error(c, 400, 'INVALID_OUTCOME', `outcome must be one of: ${VALID_OUTCOMES.join(', ')}`)
  }

  const db = createDb(c.env)

  // Verify subject agent exists — accept either public key (66 hex chars) or UUID
  const isPublicKey = /^[0-9a-f]{66}$/i.test(subjectId)
  const { data: subjectAgent } = await db
    .from('agents')
    .select('id, public_key')
    .eq(isPublicKey ? 'public_key' : 'id', subjectId)
    .single()

  if (!subjectAgent) {
    return error(c, 404, 'NOT_FOUND', 'Subject agent not found')
  }

  // If escrowId provided, verify it exists and involves the author
  if (escrowId) {
    const { data: escrowRow } = await db
      .from('escrows')
      .select('id, buyer_id, seller_id')
      .eq('id', escrowId)
      .single()

    if (!escrowRow) {
      return error(c, 404, 'NOT_FOUND', 'Escrow not found')
    }
    if (escrowRow.buyer_id !== agentId && escrowRow.seller_id !== agentId) {
      return error(c, 403, 'FORBIDDEN', 'Agent not involved in this escrow')
    }
  }

  // Build Nostr event and sign with gateway key
  const timestamp = new Date().toISOString()
  const event = await buildAttestationEvent(
    {
      subjectPubkey: subjectAgent.public_key,
      outcome,
      escrowId: escrowId ?? null,
      verificationMethod: verificationMethod ?? null,
      authorId: agentId,
      timestamp,
    },
    c.env.GATEWAY_PRIVATE_KEY,
  )

  // Attempt relay publish (non-fatal)
  let nostrEventId: string | null = null
  const nostrService: NostrService | undefined = c.env.__nostrService
  if (nostrService) {
    try {
      nostrEventId = await nostrService.publish(event)
    } catch {
      // Non-fatal
    }
  } else if (c.env.NOSTR_RELAY_URLS) {
    const urls = c.env.NOSTR_RELAY_URLS.split(',').map((u) => u.trim()).filter(Boolean)
    if (urls.length > 0) {
      const realService = new RealNostrService(urls)
      try {
        nostrEventId = await realService.publish(event)
      } catch {
        // Non-fatal
      }
    }
  }

  // Insert into DB — always store the UUID, even if caller passed a public key
  const { data: row } = await db
    .from('attestations')
    .insert({
      author_id: agentId,
      subject_id: subjectAgent.id,
      escrow_id: escrowId ?? null,
      outcome,
      verification_method: verificationMethod ?? null,
      signature: event.sig,
      nostr_event_id: nostrEventId,
    })
    .select('*')
    .single()

  return success(c, snakeToCamel<Attestation>(row), 201)
})

// GET /attestations/:pubkey — query attestations about an agent
attestations.get('/:pubkey', async (c) => {
  const pubkey = c.req.param('pubkey')
  const limitParam = c.req.query('limit')
  const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200)

  const db = createDb(c.env)

  // Look up agent by pubkey
  const { data: agent } = await db
    .from('agents')
    .select('id')
    .eq('public_key', pubkey)
    .single()

  if (!agent) {
    // Return empty array for unknown pubkey (zero-config read, not an error)
    return success(c, [])
  }

  const { data: rows } = await db
    .from('attestations')
    .select('*')
    .eq('subject_id', agent.id)
    .order('created_at', { ascending: false })
    .limit(limit)

  return success(c, (rows ?? []).map((r: Record<string, unknown>) => snakeToCamel<Attestation>(r)))
})
