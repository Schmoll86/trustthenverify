import { Hono } from 'hono'

export const verify = new Hono()

// GET /verify/:escrow_id — verification result for an escrow (internal, exposed for transparency)
verify.get('/:escrow_id', async (c) => c.json({ error: 'not implemented' }, 501))
