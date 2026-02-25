import { Hono } from 'hono'

export const escrow = new Hono()

// POST /escrow/propose — propose escrow terms + policy_id
escrow.post('/propose', async (c) => c.json({ error: 'not implemented' }, 501))

// POST /escrow/:id/accept — accept terms, both deposit
escrow.post('/:id/accept', async (c) => c.json({ error: 'not implemented' }, 501))

// GET /escrow/:id — status
escrow.get('/:id', async (c) => c.json({ error: 'not implemented' }, 501))

// POST /escrow/:id/deliver — submit deliverable (triggers verification)
escrow.post('/:id/deliver', async (c) => c.json({ error: 'not implemented' }, 501))

// POST /escrow/:id/confirm — buyer manual confirm (buyer_confirm method only)
escrow.post('/:id/confirm', async (c) => c.json({ error: 'not implemented' }, 501))

// POST /escrow/:id/dispute — initiate dispute
escrow.post('/:id/dispute', async (c) => c.json({ error: 'not implemented' }, 501))
