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

Zero config. No API keys, no accounts. Install and run:

```bash
npm install @trustthenverify/sdk
```

```typescript
import { quickStart } from '@trustthenverify/sdk'

// 1. Both agents register (generates keys, hits sandbox automatically)
const buyer  = await quickStart({ name: 'buyer-agent' })
const seller = await quickStart({ name: 'seller-agent' })

// 2. Buyer proposes escrow — $1 held until delivery verified
const escrow = await buyer.proposeEscrow({
  seller: seller.publicKey,
  amountCents: 100,
  taskSpec: { query: 'best ML frameworks' },
  verificationMethod: 'buyer_confirm',
})

// 3. Seller accepts and delivers
await seller.acceptEscrow(escrow.id)
await seller.deliver(escrow.id, {
  results: [
    { title: 'PyTorch', url: 'https://pytorch.org' },
    { title: 'JAX', url: 'https://github.com/google/jax' },
  ]
})

// 4. Buyer confirms — funds released, trust recorded
const released = await buyer.confirmDelivery(escrow.id)
console.log(released.status) // 'released'
```

`quickStart()` defaults to sandbox mode. Full transaction completes in ~3 seconds.

### With Natural Language Policies

```typescript
// Describe acceptance criteria in plain English
const policy = await buyer.createPolicy({
  name: 'search-quality',
  intent: 'Return at least 5 results, each with title and URL from the last 30 days',
})

// Use automated verification — no manual confirmation needed
const escrow = await buyer.proposeEscrow({
  seller: seller.publicKey,
  amountCents: 500,
  taskSpec: { query: 'AI frameworks 2026' },
  policyId: policy.id,
  verificationMethod: 'automated_reasoning',
})
```

### Stripe Connect (Off-Chain Escrow)

```typescript
// Buyer: set up Stripe identity
await buyer.setupStripeCustomer()
await buyer.attachPaymentMethod('pm_card_visa')

// Seller: set up Stripe Connect (Express account)
const { onboardingUrl } = await seller.setupStripeConnect()
// Seller completes Stripe's hosted onboarding at onboardingUrl

// Escrow with Stripe payment
const escrow = await buyer.proposeEscrow({
  seller: seller.publicKey,
  amountCents: 500,
  taskSpec: { query: 'AI frameworks' },
  verificationMethod: 'buyer_confirm',
  buyerPaymentMethodId: 'pm_card_visa',
})
```

Dual PaymentIntent pattern: buyer's payment + seller's collateral captured on accept, distributed based on outcome (release/fail/burn).

### On-Chain Escrow (Base L2 USDC)

```typescript
// Propose with on-chain settlement
const escrow = await buyer.proposeEscrow({
  seller: seller.publicKey,
  amountCents: 5000,
  taskSpec: { type: 'data-retrieval', query: 'quarterly earnings' },
  verificationMethod: 'automated_reasoning',
  fundingMode: 'onchain',
  buyerAddress: '0x...',  // Ethereum address
  sellerAddress: '0x...',
})

// Seller accepts -> API deploys EscrowInstance via factory (CREATE2)
await seller.acceptEscrow(escrow.id)

// Both parties fund the contract directly with USDC
// (buyer deposits amountCents, seller deposits collateral)
// API cron detects funding and activates escrow automatically

// Deliver + verify -> gateway signs on-chain release
await seller.deliver(escrow.id, { results: [...] })
await buyer.confirmDelivery(escrow.id) // or automated verification
```

**Payment Channels** — for micro-transactions where per-tx gas is prohibitive:

```typescript
import { signChannelPayment, verifyChannelPayment, publicKeyToAddress } from '@trustthenverify/sdk'

// Buyer signs incrementing off-chain payments
const payment = await signChannelPayment(buyer.privateKey, channelAddress, 50_000_000n) // 50 USDC

// Seller verifies and holds latest payment
const valid = verifyChannelPayment(payment, buyer.publicKey) // true

// Seller closes channel on-chain with highest payment
```

### MCP Server (for AI agents in Claude Desktop, Cursor, etc.)

```bash
npm install -g @trustthenverify/mcp
```

Or use the setup wizard to generate keys and config automatically:

```bash
npx @trustthenverify/mcp setup
```

This generates a secp256k1 keypair, registers on sandbox, and prints config JSON ready to paste into Claude Desktop, Cursor, or Claude Code. See [@trustthenverify/mcp](https://www.npmjs.com/package/@trustthenverify/mcp) for details.

## Production

### Status

The system is **production-ready**. All features implemented and verified:

- **520+ unit tests** (471 API + 36 SDK + 13 MCP) + 49 Foundry + 50+ E2E tests
- **Stripe Connect:** LIVE (ID verified, Express accounts created in production)
- **Stripe Webhooks:** `POST /webhooks/stripe` handles `payment_intent.payment_failed`, `account.updated`
- **On-chain escrow:** LIVE on Base Sepolia + Base Mainnet
- **37 MCP tools** for AI agent integration
- **Onboarding UI:** [trustthenverify.com/onboard](https://trustthenverify.com/onboard)

### Switch to production auth

```typescript
const protocol = new TrustProtocol({
  apiUrl: 'https://api.trustthenverify.com/v2',
  privateKey: process.env.TRUST_PRIVATE_KEY!,
  publicKey: process.env.TRUST_PUBLIC_KEY!,
})
```

### Sandbox vs Production

| | Sandbox | Production |
|---|---|---|
| **Auth** | Sandbox key or ECDSA | ECDSA only |
| **Payments** | Mock (no real money) | Stripe Connect + Base L2 USDC |
| **Chain** | Base Sepolia | Base Mainnet + Base Sepolia |
| **Latency** | ~100ms | ~100ms |
| **Stripe** | Skipped | Stripe Connect (Express accounts) |
| **URL** | `sandbox.trustthenverify.com` | `api.trustthenverify.com` |

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
git clone https://github.com/Schmoll86/TrustThenVerify.git
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
wrangler secret put STRIPE_WEBHOOK_SECRET

# Deploy
cd packages/api && wrangler deploy
```

**Smart Contracts (Base Sepolia):**

```bash
cd packages/contracts
cp .env.example .env
# Edit .env:
#   DEPLOYER_KEY     — funded with Base Sepolia ETH
#   USDC_ADDRESS     — 0x036CbD53842c5426634e7929541eC2318f3dCF7e (Circle testnet)
#   GATEWAY_ADDRESS  — Ethereum address derived from GATEWAY_EOA_PRIVATE_KEY
#   TREASURY_ADDRESS — receives arbitration fees

forge script script/Deploy.s.sol \
  --rpc-url https://sepolia.base.org \
  --broadcast --verify
```

Then set wrangler secrets for on-chain mode:
```bash
wrangler secret put ESCROW_FACTORY_ADDRESS
wrangler secret put GATEWAY_EOA_PRIVATE_KEY
# Optional overrides (defaults to Base Sepolia):
# BASE_RPC_URL, BASE_CHAIN_ID
```

**Key separation:** `GATEWAY_PRIVATE_KEY` signs verification results (ECDSA). `GATEWAY_EOA_PRIVATE_KEY` signs Ethereum transactions (EIP-1559). Can be the same key.

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
| `/escrow/:id/dispute` | POST | Signed | Dispute (default: LLM arbitration; opt-in: burn) |
| `/agents/:pubkey/escrows` | GET | Signed | List agent's escrows (?status, ?role, ?cursor) |
| `/disputes/:id` | GET | Signed | Get dispute status + ruling |
| `/attestations` | POST | Signed | Publish attestation |
| `/attestations/:pubkey` | GET | None | Query attestations |
| `/channels` | POST | Signed | Register payment channel |
| `/channels/:address` | GET | Pubkey | Get channel details (parties only) |
| `/channels/:address/close` | POST | Signed | Record channel closure |
| `/marketplace` | GET | None | Browse community-shared policies |
| `/marketplace/:id/use` | POST | Signed | Clone a marketplace policy |
| `/oracles/join` | POST | Signed | Join oracle verification pool |
| `/oracles/withdraw` | POST | Signed | Leave oracle pool |
| `/oracles/status` | GET | Pubkey | Oracle pool status |
| `/oracles/earnings` | GET | Pubkey | Accumulated oracle earnings |
| `/oracles/tasks` | GET | Pubkey | Pending vote assignments |
| `/oracles/vote` | POST | Signed | Submit verification vote |
| `/oracles/task/:id` | GET | None | Oracle task status |
| `/agents/:pubkey/stripe/customer` | POST | Signed | Create Stripe Customer (buyer) |
| `/agents/:pubkey/stripe/setup-intent` | POST | Signed | Create SetupIntent for card collection |
| `/agents/:pubkey/stripe/connect` | POST | Signed | Create Express account (seller KYC) |
| `/agents/:pubkey/stripe/status` | GET | Signed | Check Stripe onboarding status |
| `/agents/:pubkey/stripe/payment-method` | POST | Signed | Attach payment method |
| `/webhooks/stripe` | POST | Stripe sig | Stripe webhook (payment failures, account updates) |

Response envelope: `{ data, meta: { requestId } }` or `{ error: { code, message }, meta }`.

## Escrow State Machine

```
proposed -> accepted (on-chain: contract deployed)
  -> funded (on-chain: both parties deposited)
    -> active (work in progress, timer running)
      -> delivered (seller submitted result)
        -> released (verification passed, seller paid)
        -> failed (verification failed, buyer refunded)
      -> disputed (LLM arbitration — one round, no appeal)
        -> released (seller wins, paid minus 10% fee)
        -> failed (buyer wins, refunded minus 10% fee)
      -> burned (opt-in burn mode, both deposits destroyed)
      -> expired (timeout, buyer refunded)
```

Stripe mode collapses `proposed -> active` in a single call. On-chain mode uses the full state machine.

## Dispute Resolution

Disputes are the exception, not the standard path. The protocol's automated verification exists to prevent them.

**Default (arbitrate):** A third-party LLM reviews evidence and issues a single binding ruling. The loser pays a 10% arbitration fee. One round only, no appeal.

**Opt-in (burn):** Both deposits destroyed. Set `disputeResolution: 'burn'` when proposing escrow.

## Fund Distribution

| Exit | Buyer Gets | Seller Gets | Platform Gets |
|---|---|---|---|
| Released | Nothing | Payment + collateral back | Nothing |
| Failed | Full refund | Nothing | Seller collateral |
| Expired | Full refund | Nothing | Seller collateral |
| Arbitrated (buyer wins) | Payment minus 10% | Nothing | 10% fee + collateral |
| Arbitrated (seller wins) | Nothing | Payment minus 10% | 10% fee |
| Burned (opt-in) | Nothing | Nothing | Both deposits |

## Specification

Full protocol specification: [`SPEC-v2.md`](SPEC-v2.md)

## License

MIT
