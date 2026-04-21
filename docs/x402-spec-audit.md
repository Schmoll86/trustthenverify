# x402 Foundation Spec Conformance Audit

**Date:** 2026-04-21
**Scope:** `packages/api/src/routes/x402.ts`, `packages/api/src/lib/x402.ts`
**Spec source:** https://docs.x402.org (x402.org / x402 Foundation, April 2026)
**Audit goal:** document divergences between TTV's x402 implementation and the spec; file breaking divergences for fix, queue non-breaking ones.

## Executive summary

TTV ships a **custodial x402 facilitator** (gateway holds USDC; settles to seller on release; issues signed macaroons as payment proof). The public spec at docs.x402.org describes a **thin HTTP 402 challenge/response + facilitator verify/settle pattern**. TTV's flow is richer (escrow + formal verification layered on top), so we have divergences of **scope** — we do more than the minimal spec — and potentially of **wire format** on the shared surface.

**Status:** TTV is *functionally x402-compatible* (USDC on Base L2, facilitator-mediated settlement). TTV is *not wire-format compatible* with spec-compliant clients. A spec-compliant `/verify` + `/settle` surface would let any off-the-shelf x402 client pay a TTV seller without TTV-specific SDK code. That's the adoption wedge this audit identifies.

## Spec surface (what docs.x402.org documents)

From docs.x402.org/core-concepts/http-402 and .../facilitator:

| Element | Spec wire format |
|---|---|
| Challenge status | `402 Payment Required` |
| Challenge header | `PAYMENT-REQUIRED` (Base64-encoded `PaymentRequired` object) |
| Challenge body | Not authoritative — payment details live in the header |
| Client payment header | `PAYMENT-SIGNATURE` (Base64-encoded `PaymentPayload` object) |
| Server settlement header | `PAYMENT-RESPONSE` (Base64-encoded `SettlementResponse` object) |
| Facilitator endpoints | `POST /verify`, `POST /settle` |
| Supported networks | Base, Solana, Polygon, Avalanche, "and more" |
| Supported schemes | `exact` (referenced); others implied |
| Discovery | Not documented at the protocol level (no canonical `.well-known`) |

**Missing from public docs (spec incomplete from our POV):** exact JSON schemas for `PaymentRequired`, `PaymentPayload`, `SettlementResponse`; concrete field names; asset-identifier format (CAIP-19? EIP-3770?); expiry / nonce handling. The OpenAPI at docs.x402.org/api-reference/openapi.json is a placeholder (pet-store example as of this audit date).

**Action:** follow up by inspecting the reference client (coinbase/x402 on GitHub) to recover the concrete schemas; cross-check against SVM Scheme Specification link on docs.x402.org.

## TTV current surface

### Public x402 routes (`packages/api/src/routes/x402.ts`)

| Endpoint | Method | Purpose | Spec analog |
|---|---|---|---|
| `/v2/x402/balance/:address` | GET | Check USDC balance on Base | (none — TTV-specific) |
| `/v2/x402/verify-macaroon` | POST | Verify macaroon signature | (none — TTV-specific) |

### Internal payment/settlement flow (via escrow routes)

Buyer → proposeEscrow → receive `X402PaymentInstructions` (TTV JSON shape, below) → send USDC on-chain → POST `/v2/escrow/:id/x402-pay` with tx hash → TTV verifies receipt → TTV mints macaroon → seller delivers → buyer confirms → TTV settles to seller via `settleToSeller`.

### TTV types (`packages/api/src/lib/x402.ts`)

```ts
interface X402PaymentInstructions {
  gatewayAddress: string
  amountUsdc: string       // "5.50"
  amountUsdcRaw: string    // "5500000" (6 decimals)
  chainId: number          // 8453
  usdcContract: string
  escrowId: string
  nonce: string
  expiresAt: string
}
```

```ts
interface MacaroonPayload {
  escrowId: string
  buyerAddress: string
  sellerAddress: string
  amountCents: number
  issuedAt: string
  expiresAt: string
  nonce: string
}
```

## Divergences

### D1 — No HTTP 402 challenge emitted [non-breaking, opportunity]

**Spec:** Seller's resource returns `402 Payment Required` + `PAYMENT-REQUIRED` header with base64-encoded instructions.

**TTV:** Payment instructions are delivered via a `proposeEscrow` API call that returns JSON, not via a 402 challenge at the seller's own URL.

**Why divergent:** TTV treats the facilitator as the orchestration entry, not the seller. Fine for the TTV-SDK flow, hostile to a generic x402 client that expects to hit the *seller's* endpoint, get a 402, then pay.

**Recommended fix:** expose an optional spec-conforming flow. A seller who wants x402 clients to reach them directly should be able to stand up a TTV-backed HTTP 402 challenge. Deferred — filed as spec-conformance tracking item. Non-breaking for existing TTV users.

### D2 — Header names do not match spec [breaking for third-party clients]

**Spec:** `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE` (all base64-encoded payloads).

**TTV:** no use of these headers. Instructions are in a JSON response body; payment proof is submitted as a JSON body to `/v2/escrow/:id/x402-pay`; settlement is signaled in the JSON response body.

**Recommended fix:** if/when D1 is addressed, emit/accept the spec headers in addition to current JSON. Dual-route during the transition. **Do not silently remove** the current JSON surface — all TTV SDK users (0.3.x) depend on it.

### D3 — No `/verify` or `/settle` facilitator endpoints [breaking for spec-compliant facilitator role]

**Spec:** a facilitator exposes `POST /verify` (accepts Payment Payload + Payment Details → Verification Response) and `POST /settle` (accepts the same → Payment Execution Response).

**TTV:** there are no such endpoints. TTV's `verifyPayment()` is an internal library function, not an HTTP endpoint; `settleToSeller()` is also internal. Sellers cannot treat TTV as a drop-in x402 facilitator because the facilitator API is not HTTP-exposed.

**Recommended fix (queued):** add `POST /v2/x402/verify` and `POST /v2/x402/settle` that proxy to the internal library. Keep them gated by gateway-signed seller identity so they can't be abused as a free verification service. Non-trivial work; defer until demand (e.g. a third-party seller asks for it).

### D4 — `X402PaymentInstructions` field names vs. spec [unknown — spec schema not public]

Our shape uses `gatewayAddress`, `amountUsdc`, `amountUsdcRaw`, `chainId`, `usdcContract`, `nonce`, `expiresAt`, `escrowId`. The spec's `PaymentRequired` schema is not published in the public docs at audit time, so direct comparison is blocked. We cannot assert conformance without the schema.

**Recommended follow-up:** read the reference client source (coinbase/x402 GitHub) to reconstruct the concrete schema, then close D4. Until then, publish our facilitator manifest (`/.well-known/x402.json`) describing our shape explicitly — agents that crawl our surface can generate adapters.

### D5 — Network identifier [non-breaking if spec uses CAIP-2]

**Spec:** unclear — docs mention "Base" by name but don't commit to a canonical format.

**TTV:** `chainId: 8453` as a plain integer. Our `/.well-known/x402.json` (introduced this session) publishes **both** `chainId: 8453` and `caip2: "eip155:8453"` to cover the likely spec options.

### D6 — Asset identifier [non-breaking]

**Spec:** again not explicitly documented in the public references. Presumably a contract address + chain.

**TTV:** `usdcContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"` — Circle's official Base L2 USDC. Matches industry expectation. No fix needed.

### D7 — Discovery surface [opportunity, not divergence]

**Spec:** no canonical `.well-known` path. The Foundation hasn't standardized facilitator discovery yet.

**TTV:** this session we proactively published `/.well-known/x402.json` describing our facilitator capability. Not a divergence — this is new ground. If the Foundation later standardizes a different path (e.g. `/.well-known/x402-facilitator.json`), we'll mirror.

## Action items

| ID | Action | Priority | Owner | Blocks |
|---|---|---|---|---|
| A1 | Fetch reference client (coinbase/x402) — recover `PaymentRequired` / `PaymentPayload` / `SettlementResponse` schemas | High | next session | D4 closure |
| A2 | Draft spec-conforming 402 challenge flow as opt-in adapter | Medium | not this session | D1 + D2 |
| A3 | Expose `POST /v2/x402/verify` + `POST /v2/x402/settle` as spec-facilitator endpoints | Low (demand-driven) | when a 3P seller asks | D3 |
| A4 | Publish facilitator manifest at `/.well-known/x402.json` | **DONE (this session)** | — | D7 |
| A5 | Track Foundation discovery-path decision; update manifest URL if they pick a different convention | Low (monitoring) | quarterly check | — |

## What we are NOT fixing this session

- Nothing. This audit is read-only per the plan: "**Do not silently fix divergences** — file them as commits with the spec section cited." All items above are queued.

## References

- x402 homepage: https://x402.org
- Protocol docs: https://docs.x402.org
- HTTP 402 core concept: https://docs.x402.org/core-concepts/http-402
- Facilitator role: https://docs.x402.org/core-concepts/facilitator
- OpenAPI (placeholder at audit date): https://docs.x402.org/api-reference/openapi.json
- TTV facilitator manifest: https://api.trustthenverify.com/.well-known/x402.json
