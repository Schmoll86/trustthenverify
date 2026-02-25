import { Hono } from 'hono'

const app = new Hono()

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/', (c) => c.json({ name: 'TrustThenVerify API', version: '0.1.0' }))

// ── Trust lookups (Section 10.3) ──────────────────────────────────────────────
// GET /v1/trust/:id         — score + tier + breakdown
// GET /v1/trust/:id/history — append-only score event log
// GET /v1/trust/:id/badge.svg

// ── Registration ──────────────────────────────────────────────────────────────
// POST /v1/register

// ── Operator layer (Section 4) ────────────────────────────────────────────────
// POST /v1/operators/register
// POST /v1/operators/verify/:chain
// POST /v1/operators/agents/batch
// POST /v1/operators/agents/dormant
// POST /v1/operators/agents/reactivate

// ── Autonomous challenges (Section 4.9) ───────────────────────────────────────
// POST /v1/registry/challenge/batch
// POST /v1/registry/challenge/submit
// GET  /v1/registry/challenge/available

// ── Transactions & reviews ────────────────────────────────────────────────────
// POST /v1/registry/transaction
// POST /v1/registry/review
// POST /v1/registry/payment/request
// GET  /v1/registry/payment/:id

// ── Discovery ─────────────────────────────────────────────────────────────────
// GET /v1/registry/search

export default app
