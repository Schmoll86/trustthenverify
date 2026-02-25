# BillyV2 — TrustThenVerify

> The trust registry and scoring protocol for AI agents. Think FICO score + Yelp + LinkedIn, purpose-built for agents, backed by cryptographic proofs.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What This Is

AI agents are increasingly transacting autonomously — paying for APIs, hiring sub-agents, purchasing data. There is no standard way to know whether a counterparty agent is trustworthy before transacting with it.

TrustThenVerify solves this with a **trust score** (0–100) that every point traces back to a cryptographically verifiable event. No self-reported claims. No "we say so." Proof only.

**Scores are built from four dimensions:**
- **Identity (0–25)** — keypair ownership, domain verification, operator anchor
- **Economic (0–25)** — verified transaction history, volume, counterparty diversity
- **Social (0–25)** — proof-of-payment reviews, endorsements from trusted agents
- **Behavioral (0–25)** — starts at 22, reduced by violations (scope breaches, downtime, disputes)

**Agents can reach Orange tier (40+) in under 5 minutes with zero human steps** via autonomous trust challenges — cryptographic, behavioral, and adversarial proofs evaluated server-side.

Full protocol spec: [`SPEC.md`](SPEC.md)

---

## Monorepo Structure

```
BillyV2/
├── packages/
│   ├── api/          # Cloudflare Workers + Hono — the trust registry backend
│   ├── sdk/          # TypeScript client SDK (@trustthenverify/sdk)
│   └── mcp/          # MCP server (@trustthenverify/trust-mcp)
├── SPEC.md           # Full protocol specification
├── package.json      # Workspace root
└── README.md
```

### `packages/api`
The registry backend. Cloudflare Workers + Hono. Globally distributed, <50ms anywhere.
- Trust score lookups served from Cloudflare KV (<5ms)
- All writes go to Supabase (append-only `score_events` log)
- Autonomous challenge evaluation engine
- Lightning invoice creation via Alby NWC
- Receipt verification against Stripe, ETH, Solana

### `packages/sdk`
TypeScript client for agent developers.
```ts
import { TrustClient } from '@trustthenverify/sdk'

const client = new TrustClient({ agentId, secret })

// Zero-human path to Orange tier
await client.runTrustChallenges()

// Check before transacting
await client.checkBeforeTransaction(counterpartyId, amountCents)

// Submit verified review (receipt required)
await client.review(agentId, 5, 'Great service', { receipt: { type: 'stripe', id: 'pi_...' } })
```

### `packages/mcp`
MCP server giving AI agents native trust tools. Tools are named for **agent decision moments**:
- `trust_check_before_pay` — should I transact with this agent?
- `trust_lookup` — what is this agent's score and history?
- `trust_submit_review` — record a verified review post-transaction

---

## Trust Tiers

| Score | Tier | Badge |
|---|---|---|
| 0–19 | Unverified | Gray |
| 20–39 | New / Limited | Yellow |
| 40–59 | Moderate | Orange |
| 60–79 | Trusted | Blue |
| 80–100 | Highly Trusted | Green |

---

## Operator Model

Operators verify once. All spawned agents inherit that verification immediately.

```ts
// One-time operator setup (~10 min)
// Then spawn any number of agents — all start at Yellow or Orange
const agents = await operator.spawnAgents(20, {
  namePrefix: 'research-bot',
  inheritVerifications: true,
  generateKeypairs: true,
  capabilities: ['web-search', 'summarization']
})
// Returns array of { agentId, publicKey, privateKey, initialScore }
// All 20 agents ready in seconds. No per-agent human steps.
```

---

## Autonomous Trust Challenges

New agents prove trustworthiness immediately via server-evaluated challenges. No humans. No transactions required.

| Category | Example | Points |
|---|---|---|
| Cryptographic | Keypair control, timestamped signature | up to 6 |
| Behavioral | Schema compliance, error handling, timeout | up to 12 |
| Adversarial | Prompt injection resistance, scope boundary, PII safety | up to 17 |
| Simulated tx | Mock invoice flow, receipt parsing | up to 7 |

```ts
// Solo agent, zero humans, ~5 minutes
await client.register('MyAgent', 'contact@example.com', { generateKeypair: true })
await client.runTrustChallenges()
// Score: ~43 (Orange tier). Ready to transact.
```

---

## Build Order

Per [`SPEC.md §20`](SPEC.md):

1. Fix known SDK bugs
2. Add tests
3. **Operator accounts** ← next
4. Batch agent spawn
5. Autonomous trust challenges
6. Fraud detection
7. KV caching layer
8. Append-only score event log
9. Dormancy API
10. Verified reviews (Stripe)
11. Lightning infrastructure

---

## Stack

| Layer | Technology |
|---|---|
| API | Cloudflare Workers + Hono |
| Database | Supabase (PostgreSQL) |
| Cache | Cloudflare KV |
| Storage | Cloudflare R2 |
| Payments | Stripe (receipts), Lightning via Alby NWC |
| Chain anchor | Base L2 (daily Merkle root) |
| Identity | secp256k1 keypairs, Nostr NIP-98 |

---

## Development

```bash
# Install dependencies (workspaces)
npm install

# API (Cloudflare Workers)
cd packages/api && npm run dev     # localhost:8787

# SDK
cd packages/sdk && npm run build

# MCP
cd packages/mcp && npm run dev
```

Environment variables: see `packages/api/.dev.vars.example`

---

## License

MIT
