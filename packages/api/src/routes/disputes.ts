import { Hono } from 'hono'

export const disputes = new Hono()

// POST /disputes — file for arbitration
disputes.post('/', async (c) => c.json({ error: 'not implemented' }, 501))

// GET /disputes/:id — status
disputes.get('/:id', async (c) => c.json({ error: 'not implemented' }, 501))

// POST /disputes/:id/ruling — arbitrator submits ruling
disputes.post('/:id/ruling', async (c) => c.json({ error: 'not implemented' }, 501))
