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
2. `loggingMiddleware` — requestId generation, JSON structured logging
3. Health routes (`/`, `/v2/health`) — no auth required
4. `authMiddleware` — ECDSA or sandbox key auth
5. `rateLimitMiddleware` — per-agent KV sliding window (60 writes/min, 300 reads/min)
6. Route handlers

## Dispute Resolution
- **Default: `arbitrate`** — LLM judge (Gemini 2.5 Flash via OpenRouter) reviews evidence, rules `buyer_wins` or `seller_wins`. Single round, no appeal. Loser pays 10% fee.
- **Opt-in: `burn`** — nuclear option, both parties lose everything.
- Arbitration service: `packages/api/src/lib/arbitration-service.ts` (follows GatewayService pattern)
- Prompts: `packages/api/src/lib/arbitration-prompts.ts`

## Testing
- `vitest` for both SDK and API.
- SDK: unit tests for crypto functions.
- API: integration tests via `app.request()` with mock Supabase (`src/__tests__/helpers/mock-db.ts`).
- E2E: `packages/e2e/` — tests against live sandbox (not in workspaces, manual run).
- Run unit tests: `npm test --workspaces -- --run`
- Run E2E: `cd packages/e2e && E2E_API_URL=https://sandbox.trustthenverify.com/v2 E2E_SANDBOX_KEY=<key> npx vitest --run`

## Before Committing
- `npm run build --workspace=packages/sdk` must succeed
- `npm run typecheck --workspace=packages/api` must succeed
- `npm test --workspaces -- --run` must pass
