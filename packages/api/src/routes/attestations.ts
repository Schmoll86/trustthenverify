import { Hono } from 'hono'

export const attestations = new Hono()

// POST /attestations — publish signed attestation (relayed to Nostr)
attestations.post('/', async (c) => c.json({ error: 'not implemented' }, 501))

// GET /attestations/:pubkey — query attestations about an agent
attestations.get('/:pubkey', async (c) => c.json({ error: 'not implemented' }, 501))
