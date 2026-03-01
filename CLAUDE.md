# TrustThenVerify — Project Instructions

## What This Is
Escrow + verification protocol for autonomous AI agent commerce. Agents register with secp256k1 keypairs, transact via escrow with formal policy verification, and build local trust models from direct experience.

## Source of Truth
- `SPEC-v2.md` — the full protocol specification. Read relevant sections before implementing.
- Build order is in §11. We are building phase by phase.

## Architecture
- `packages/api` — Cloudflare Workers + Hono. API + Verification Gateway.
- `packages/sdk` — TypeScript SDK. Client-side crypto, types, TrustProtocol class.
- `packages/mcp` — MCP server for AI agent tool integration.
- Database: Supabase PostgreSQL. Schema in `packages/api/supabase/migrations/`.

## Conventions
- **Types live in SDK only.** API imports from `@trustthenverify/sdk`.
- **API uses internal snake_case row types** in `packages/api/src/lib/types.ts`.
- **Case mapping at DB boundary:** `snakeToCamel()`/`camelToSnake()` in `lib/case.ts`.
- **Response envelope (§9.4):** `{ data, meta: { requestId } }` or `{ error: { code, message }, meta }`.
- **Auth middleware** reads body once, stores as `rawBody` variable. Route handlers use `c.get('rawBody')`.
- **SDK is ESM:** `moduleResolution: "nodenext"`, `.js` extensions on all relative imports.

## Middleware Stack (outermost → innermost)
1. `app.onError(errorHandler)` — error boundary, returns 500 JSON envelope
2. `cors()` — Hono CORS middleware, allows `trustthenverify.com`, `www.trustthenverify.com`, `sandbox.trustthenverify.com`
3. `loggingMiddleware` — requestId generation, JSON structured logging
4. Health routes (`/`, `/v2/health`) — no auth required
5. Webhooks (`/webhooks/stripe`) — before auth, uses Stripe signature verification
6. `authMiddleware` — ECDSA or sandbox key auth
7. `rateLimitMiddleware` — per-agent KV sliding window (60 writes/min, 300 reads/min)
8. Route handlers

## Dispute Resolution
- **Default: `arbitrate`** — LLM judge (Gemini 2.5 Flash via OpenRouter) reviews evidence, rules `buyer_wins` or `seller_wins`. Single round, no appeal. Loser pays 10% fee.
- **Opt-in: `burn`** — nuclear option, both parties lose everything.
- Arbitration service: `packages/api/src/lib/arbitration-service.ts` (follows GatewayService pattern)
- Prompts: `packages/api/src/lib/arbitration-prompts.ts`

## On-Chain Escrow (Base L2)
- **Status:** LIVE on Base Sepolia + Base Mainnet. Factory deploys EscrowInstance contracts via API. Verified end-to-end.
- **Addresses:** Factory `0xE1E21350E4807adB472fbBb904Cd2Da75Eb77e1e`, Gateway/Treasury `0x2299244F6c99E59A1f8197509030428030aaaff9`, USDC (Sepolia) `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, USDC (Mainnet) `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- **Key fallback:** `GATEWAY_EOA_PRIVATE_KEY` falls back to `GATEWAY_PRIVATE_KEY` if not set. Both derive to `0x2299244F...`.
- **Hashing:** All Ethereum hashing uses `keccak_256` from `@noble/hashes/sha3.js` — function selectors, message hashes, address derivation, tx signing.
- **Noble secp256k1 v3 recovery:** `format: 'recovered'` returns `recovery(1) || r(32) || s(32)` — recovery byte is FIRST. Ethereum convention is `r || s || v` — must reformat after signing.
- **EIP-1559 tx signing:** v = recovery (0 or 1), NOT +27. Legacy/personal sign: v = recovery + 27.
- **L2 gas optimization:** Base Sepolia base fee ~0.006 gwei. Priority fee = 1000 wei (not 1.5 gwei). Factory create costs ~0.000027 ETH.
- **RLP encoder:** `packages/api/src/lib/rlp.ts` — minimal Ethereum Yellow Paper implementation.
- **On-chain service:** `packages/api/src/lib/onchain.ts` — derives sender address, builds EIP-1559 txns, signs via noble.
- **Payment channels:** API routes at `/v2/channels`, SDK methods `registerChannel/getChannel/closeChannel`, signing helpers in `packages/sdk/src/channels.ts`.
- **Contracts:** `packages/contracts/` (Foundry standalone). EscrowFactory (CREATE2), EscrowInstance (8 states), PaymentChannel (unidirectional USDC).
- **Config:** `ESCROW_FACTORY_ADDRESS` in wrangler.toml `[vars]`. `GATEWAY_EOA_PRIVATE_KEY` optional (falls back to `GATEWAY_PRIVATE_KEY`).

## Stripe Integration
- Account: FindSquad, Inc. (`acct_1ST8scJc7Iv6B67g`), live mode.
- Live restricted key (`rk_live_`) with 7 Write permissions: Customers, Accounts, Account Links, Payment Intents, Payment Methods, Transfers, Refunds.
- **Stripe Connect: WORKING** — platform ID verified, Express accounts can be created in production.
- Buyer-side (Stripe Customer creation) works in production.
- Seller-side (Express connected accounts + onboarding) works in production.
- SetupIntents: `POST /v2/agents/:pubkey/stripe/setup-intent` — creates SetupIntent for Stripe Elements card collection. Requires `Setup Intents: Write` permission on restricted key.
- Webhook: `POST /webhooks/stripe` — handles `payment_intent.payment_failed` and `account.updated` events. Signature verified via `STRIPE_WEBHOOK_SECRET`.
- Publishable key: `pk_live_51ST8sc...` embedded in onboarding page (client-side safe).
- Service: `packages/api/src/lib/stripe.ts` — raw `fetch()` to `api.stripe.com/v1`.
- **PaymentIntent creation:** Must set `automatic_payment_methods[enabled]=true` + `automatic_payment_methods[allow_redirects]=never` when using `confirm: true` (API-only flows have no browser redirect).
- **Escrow fund release:** Stripe transfer to seller's Connect account is wrapped in try/catch — if seller hasn't completed KYC, funds stay in platform for later transfer (doesn't block escrow completion).

## Testing
- `vitest` for both SDK and API.
- SDK: unit tests for crypto functions.
- API: integration tests via `app.request()` with mock Supabase (`src/__tests__/helpers/mock-db.ts`).
- E2E sandbox: `packages/e2e/` — tests against live sandbox (not in workspaces, manual run).
- E2E production: `packages/e2e/live-full.test.ts` — 31 tests against `api.trustthenverify.com` with real ECDSA auth.
- E2E on-chain: `packages/e2e/live-onchain.test.ts` — 19 tests against Base Mainnet (deploy + verify contracts on-chain).
- E2E agents: `packages/e2e/live-agents.test.ts` — 33 tests, 8 scenarios driven by Claude models (Sonnet 4.6, Haiku 4.5, Sonnet 4.5) autonomously calling the API. Requires `ANTHROPIC_API_KEY` in `packages/e2e/.env`.
- E2E phase completion: `packages/e2e/phase-completion.test.ts` — attestation query, argus refinement, oracle pool, marketplace (sandbox).
- E2E commerce trial: `packages/e2e/live-commerce-trial.ts` — 4 real-money production escrows ($5.50 total), Stripe rails, automated reasoning + buyer confirm + LLM arbitration. Run: `PAYMENT_METHOD_ID=pm_xxx SKIP_PAUSES=1 npx tsx packages/e2e/live-commerce-trial.ts`
- Run unit tests: `npm test --workspaces -- --run`
- Run E2E production: `cd packages/e2e && npx vitest --run live-full.test.ts`
- Run E2E on-chain: `cd packages/e2e && npx vitest --run live-onchain.test.ts`
- Run E2E agents: `cd packages/e2e && npx vitest --run live-agents.test.ts` (~$0.35/run, ~3.5min)
- Run E2E sandbox: `cd packages/e2e && E2E_API_URL=https://sandbox.trustthenverify.com/v2 npx vitest --run`

## Policy Marketplace
- `GET /v2/marketplace` — list community-shared policies (public, no auth)
- `POST /v2/marketplace/:id/use` — clone a marketplace policy for caller's use (auth required)
- Policies have `visibility` (public/private), `usage_count`, `billing_model` (free/platform/creator) columns.
- Billing is stubbed — DB records only, no real Stripe charges for marketplace usage yet.

## Oracle Verification Enhancements
- **Buyer surcharge:** `oracle_fee_cents` auto-set on escrow propose when `verification_method=oracle_consensus` (default $5, env `ORACLE_FEE_CENTS`). Fee split among voting oracles.
- **Capability filtering:** `selectOracles()` matches task's `requiredCapabilities` to oracle pool capabilities. Falls back to any active oracle if insufficient matches.
- **Oracle earnings:** `GET /v2/oracles/earnings` — oracles can query accumulated earnings (pending + paid).
- **Oracle payout cron:** `handleOraclePayouts()` runs in `scheduled()` — uses `transferToConnectedAccount` to pay out oracle earnings via Stripe Connect.
- **Oracle payment tracking:** `funded_by` field on oracle_payments (`buyer_surcharge` or `platform`).

## Scheduled Crons
- `handleAutoRefinement(env)` runs in `scheduled()` — sweeps policies with >3 disputed escrows and no active refinement, enqueues `argus_refine`. Threshold configurable via `AUTO_REFINE_DISPUTE_THRESHOLD` env var.
- `handleOraclePayouts(env)` runs in `scheduled()` — pays out pending oracle earnings to their Stripe Connect accounts via `transferToConnectedAccount`.

## Base Mainnet Deployment
- **Status:** LIVE on Base Mainnet. Factory deployed at same deterministic address `0xE1E21350E4807adB472fbBb904Cd2Da75Eb77e1e`, verified on Basescan.
- Base mainnet USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Circle official).
- Production config: `BASE_RPC_URL` (Alchemy), `BASE_CHAIN_ID=8453`, `ESCROW_FACTORY_ADDRESS` in wrangler.toml vars.

## Rate Limiting Behavior
- KV-backed sliding window: 60 writes/min, 300 reads/min per agent.
- Headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`) only appear on **authenticated writes** (not GETs, not agent registration).
- GETs are public reads (auth middleware skips) → no `agentId` → rate limit skipped.
- Hono v4 pattern: must replace `c.res` after `next()` to inject headers (response is immutable).

## Before Committing
- `npm run build --workspace=packages/sdk` must succeed
- `npm run typecheck --workspace=packages/api` must succeed
- `npm test --workspaces -- --run` must pass
