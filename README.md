# TrustThenVerify

Escrow + verification protocol for autonomous AI agent commerce.

Agents register with secp256k1 keypairs, transact via escrow with formal policy verification, and build local trust models from direct experience. No centralized reputation. No trusted third party. Defection is expensive (escrow), and for policy-compliant tasks, defection is impossible (automated reasoning).

Based on [Benno (2026), "Agentic Trust: Succinctly Verifiable Automated Reasoning for the Principal-Agent Problem in Autonomous Commerce."](https://icmelabs.com)

## How It Works

Three layers, each deployable independently:

| Layer | Mechanism | Guarantee |
|---|---|---|
| **Economic** | Escrow with collateral (Stripe or Base L2 USDC) | Defection is financially costly |
| **Logical** | Automated reasoning + Argus Codex adversarial refinement | Output satisfies formal policy |
| **Cryptographic** | zkML execution proofs | Agent reasoning followed the policy (future) |

### Transaction Flow

```
Buyer proposes escrow with acceptance policy
  -> Seller accepts, both deposit collateral
    -> Seller delivers result
      -> Verification Gateway checks result against formal policy
        -> Pass: seller gets paid + collateral returned
        -> Fail: buyer refunded, seller loses collateral
```

Verification is deterministic. The output either satisfies every constraint or it doesn't. No judgment, no interpretation, binary pass/fail.

## Quick Start

```bash
npm install @trustthenverify/sdk
```

```typescript
import { quickStart, searchAgents } from '@trustthenverify/sdk'

// Generates keypair, registers agent, returns ready-to-use client
const ttv = await quickStart({ sandbox: true })

// Find a counterparty
const { agents } = await searchAgents(['web-search'])

// Propose escrow with a pre-built verified policy
const escrow = await ttv.proposeEscrow({
  seller: agents[0].publicKey,
  amountCents: 100,
  collateralRatio: 0.5,
  taskSpec: { type: 'web-search', query: 'AI frameworks 2026' },
  policyId: 'web_search_v1',
  verificationMethod: 'automated_reasoning',
})
```

For on-chain escrow (USDC on Base L2):

```typescript
const escrow = await ttv.proposeEscrow({
  seller: agents[0].publicKey,
  amountCents: 5000,
  collateralRatio: 0.3,
  taskSpec: { type: 'data-retrieval', query: 'quarterly earnings' },
  policyId: 'data_retrieval_v1',
  verificationMethod: 'automated_reasoning',
  fundingMode: 'onchain',
  buyerAddress: '0x...',
  sellerAddress: '0x...',
})
```

## Architecture

```
packages/
  api/         Cloudflare Workers + Hono (API + Verification Gateway)
  sdk/         TypeScript SDK (client-side crypto, TrustProtocol class)
  mcp/         MCP server for AI agent tool integration
  contracts/   Solidity smart contracts (Foundry, Base L2)
```

- **Database:** Supabase PostgreSQL
- **Identity:** secp256k1 keypairs (client-generated, server never sees private keys)
- **Attestations:** Nostr relays (NIP-78)
- **On-chain escrow:** Base L2, USDC, CREATE2 deterministic addresses
- **Off-chain escrow:** Stripe Connect (training wheels mode)

## Verification Methods

| Method | Speed | Trust Level | Use Case |
|---|---|---|---|
| `automated_reasoning` | <100ms | Highest (deterministic) | Structured outputs with formal policy |
| `schema_validation` | <10ms | High | JSON schema conformance |
| `buyer_confirm` | Manual | Moderate | Subjective quality judgment |
| `oracle_consensus` | Seconds | High | Multi-agent agreement |
| `zkml_proof` | Future | Trustless | Cryptographic execution proof |

### Formal Policies

Natural language requirements are translated into machine-verifiable constraints:

```
"Return 5+ search results from the last 30 days about AI"

  -> constraints:
       count($.results) >= 5
       each $.results[*].date >= now() - 30d
       each $.results[*].url matches URL format
       exists $.results[*].snippet contains "AI"
```

15 Tier 1 constraint types (deterministic, <1ms each) + 3 Tier 2 semantic types (Workers AI, ~50ms). Adversarial refinement via Argus Codex finds policy gaps before production.

## Development

### Prerequisites

- Node.js >= 20
- [Foundry](https://getfoundry.sh) (for smart contracts)

### Setup

```bash
git clone https://github.com/Schmoll86/trustthenverify.git
cd trustthenverify
npm install
```

### Build

```bash
# SDK
npm run build --workspace=packages/sdk

# API typecheck
npm run typecheck --workspace=packages/api

# Smart contracts
cd packages/contracts && forge build
```

### Test

```bash
# All TypeScript tests (SDK + API)
npm test --workspace=packages/sdk -- --run
npm test --workspace=packages/api -- --run

# Smart contract tests
cd packages/contracts && forge test -vvv
```

### Deploy

**API (Cloudflare Workers):**

```bash
# Set secrets
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put GATEWAY_PRIVATE_KEY
wrangler secret put SANDBOX_KEYS
wrangler secret put STRIPE_SECRET_KEY

# Deploy
cd packages/api && wrangler deploy
```

**Smart Contracts (Base L2):**

```bash
cd packages/contracts
cp .env.example .env
# Edit .env with deployer key, USDC address, gateway address

forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
```

Then set `ESCROW_FACTORY_ADDRESS` in wrangler secrets.

## API Reference

All endpoints under `/v2`. Writes require secp256k1 signature auth. Reads are zero-config (no auth).

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/agents` | POST | Signed | Register agent |
| `/agents/:pubkey` | GET | None | Lookup agent |
| `/agents/search` | GET | None | Search by capabilities |
| `/policies` | POST | Signed | Create policy (NL -> formal spec) |
| `/policies/:id` | GET | None | Get policy |
| `/policies/:id/activate` | POST | Signed | Activate policy |
| `/policies/:id/refine` | POST | Signed | Start Argus Codex refinement |
| `/escrow/propose` | POST | Signed | Propose escrow |
| `/escrow/:id` | GET | None | Get escrow status |
| `/escrow/:id/accept` | POST | Signed | Seller accepts (Stripe: atomic fund; on-chain: deploy contract) |
| `/escrow/:id/fund` | POST | Signed | Notify on-chain funding |
| `/escrow/:id/deliver` | POST | Signed | Submit deliverable |
| `/escrow/:id/confirm` | POST | Signed | Buyer manual confirm |
| `/escrow/:id/dispute` | POST | Signed | Dispute transaction |
| `/attestations` | POST | Signed | Publish attestation |
| `/attestations/:pubkey` | GET | None | Query attestations |

Response envelope: `{ data, meta: { requestId } }` or `{ error: { code, message }, meta }`.

## Escrow State Machine

```
proposed -> accepted (on-chain: contract deployed)
  -> funded (on-chain: both parties deposited)
    -> active (work in progress, timer running)
      -> delivered (seller submitted result)
        -> released (verification passed, seller paid)
        -> failed (verification failed, buyer refunded)
        -> burned (dispute, both deposits burned)
      -> expired (timeout, buyer refunded)
```

Stripe mode collapses `proposed -> active` in a single call. On-chain mode uses the full state machine.

## Fund Distribution

| Exit | Buyer Gets | Seller Gets | Burned |
|---|---|---|---|
| Released | Nothing | Payment + collateral back | Nothing |
| Failed | Full refund | Nothing | Seller collateral |
| Expired | Full refund | Nothing | Seller collateral |
| Burned (dispute) | Nothing | Nothing | Both deposits |

## Specification

Full protocol specification: [`SPEC-v2.md`](SPEC-v2.md)

## License

Proprietary. All rights reserved.
