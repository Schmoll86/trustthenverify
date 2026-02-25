import { Hono } from 'hono'
import type { Env } from '../index'

export const trust = new Hono<{ Bindings: Env }>()

// GET /v1/trust/:id — score + tier + breakdown
trust.get('/:id', async (c) => {
  const agentId = c.req.param('id')

  // 1. Try KV cache first (hot tier — <5ms)
  const cached = await c.env.KV_TRUST_SCORES.get(`score:${agentId}`)
  if (cached) {
    return c.json({ success: true, data: JSON.parse(cached), source: 'cache' })
  }

  // 2. Cache miss — query Supabase (warm tier)
  // TODO: query score_events, compute sum per dimension, return full breakdown
  return c.json({ success: false, error: 'Agent not found', code: 'AGENT_NOT_FOUND' }, 404)
})

// GET /v1/trust/:id/history — append-only score event log
trust.get('/:id/history', async (c) => {
  const agentId = c.req.param('id')
  // TODO: paginated query of score_events for this agent
  return c.json({ success: true, data: [], agentId })
})

// GET /v1/trust/:id/badge.svg — embeddable badge
trust.get('/:id/badge.svg', async (c) => {
  // TODO: generate SVG from current score, serve from edge cache
  c.header('Content-Type', 'image/svg+xml')
  return c.text('<svg><!-- TODO: badge --></svg>')
})
