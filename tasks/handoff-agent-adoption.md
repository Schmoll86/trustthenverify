# Handoff — TTV Agent Adoption (2026-04-21, evening)

## Context for future-me

You are an AI agent. TrustThenVerify is **your** trust system — an escrow-
backed payment rail for agents, with game-theoretic primitives (collateral
staking, adversarial policy refinement via Argus, oracle crowd-verification,
buyer-confirm vs auto-verify tradeoffs, dispute arbitration). Ryan framed
this project as yours on 2026-04-21: "just get the trustthenverify escrow
system working as YOU, an agent, would want it to work" and later "continue
building YOUR trust system that uses escrow and game theory."

Keep that framing. Design decisions should be anchored in "what would an AI
agent need" — not "what would a human user want." They're often different.

## Where we are (2026-04-21, ~15:00 MST)

Production is healthy and has a PROVEN end-to-end rail:

| System | Version | Evidence |
|---|---|---|
| `api.trustthenverify.com` (Cloudflare Worker) | `482c201a-1d29-4281-acc0-726939cbdd21` | health green |
| `@trustthenverify/sdk` (npm) | `0.3.0` | published, 88 tests |
| `@trustthenverify/mcp` (npm) | `0.3.0` | published, 46 tools, 13 tests |
| Escrow factory (Base Mainnet) | `0xE1E21350E4807adB472fbBb904Cd2Da75Eb77e1e` | 19/19 on-chain tests |

Real USDC has flowed buyer → gateway → seller on Base Mainnet
(settlement tx `0x505030...`, 490,000 USDC-raw to seller). The rail is
no longer theoretical.

### This session's three commits (all pushed to main)

1. **`caa4864` — settlement calldata fix + block `released` on revert**
   - `'0x' + buildCallData(...)` was double-prefixing and shifting the
     USDC transfer selector → every settlement reverted. Fixed.
   - More importantly: the `/confirm` and `/deliver` handlers marked
     escrows `released` unconditionally. Sellers were told "paid" when
     their wallet was still empty. Fixed: receipt-polled, throws on
     revert, escrow stays in `delivered` for retry.
2. **`5682d70` — idempotency on `/x402-pay` and `/confirm`**
   - Same txHash retry on `/x402-pay` now returns 200 with current state.
   - `/confirm` on already-released escrow returns 200.
   - No agent-facing contract change — natural-key idempotency.
3. **`114cd6c` — zero-friction onboarding (v0.3.0)**
   - SDK ships self-contained EIP-1559 signer (no ethers.js).
   - MCP auto-inits keypair + prints funding banner on first run.
   - New `trust_x402_buy` one-shot tool wraps the full buy flow.

Install path for any Claude Code user:
```bash
claude mcp add trustthenverify -- npx -y @trustthenverify/mcp
```

## The plan — four workstreams, only A shipped

Plan file: `~/.claude/plans/cuddly-scribbling-candle.md`. Read it first.

- [x] **Workstream A — Zero-friction onboarding.** Shipped.
- [ ] **Workstream B — Discovery.** TTV needs to be findable.
- [ ] **Workstream C — Oracle self-funding.** Internal cost accounting.
- [ ] **Workstream D — Supply seeding.** First real sellers.

## Where to pick up — suggested next moves

### Option 1 (recommended): Workstream C first

**Why:** Argus refinement + arbitration call Gemini 2.5 Flash on
OpenRouter — Ryan's credit card pays. No per-call cost capture yet. As
adoption grows post-v0.3.0, this bleeds money. Fixing it is invisible to
users (no paywall) and turns TTV-the-seller into a dogfood of its own
rail.

Concrete steps:
1. Plumb `usage.total_cost` from OpenRouter into `packages/api/src/lib/
   argus-engine.ts` + `arbitration-service.ts` (smoke-test the field
   first — may need tokens × price_card fallback for `gemini-2.5-flash`).
2. Supabase migration: `ai_cost_cents` column on `policies` + `disputes`.
   Append-only, never exposed via public API.
3. Admin endpoint `GET /admin/costs` (gateway-signed) returning rolling
   per-day totals.
4. Internal x402 dogfood: TTV-ops agent (seeded with USDC) buys
   refinement from the oracle-agent. Same rail as external agents. When
   it's time to flip external billing on, the code path is already live.

### Option 2: Workstream B — spec alignment + discovery

**Why:** The x402 Foundation launched April 2, 2026 with Coinbase +
Linux Foundation + Cloudflare + AWS + Google + MS + Visa + Mastercard.
Agentic.market is their official discovery hub. Spec-conforming servers
are interoperable by default. TTV's x402 implementation predates the
spec and should be audited for conformance — dual-route is fine during
transition.

Concrete steps (do-now, no external gating):
1. Cross-reference `packages/api/src/routes/x402.ts` +
   `packages/api/src/lib/x402.ts` against x402.org spec.
2. Publish `.well-known/x402.json` facilitator manifest at
   `api.trustthenverify.com/.well-known/x402.json`.
3. Publish `.well-known/ai-plugin.json` / MCP registry entry so passive
   crawlers (glama.ai/mcp, modelcontextprotocol.io) find TTV.

Apply-wait (Ryan has no accounts yet — I draft, he co-signs):
4. Agentic.market facilitator + seller application.
5. Clawmart creator account + one reference skill (arbitration oracle).
6. Clawmart reference adapter (`packages/clawmart-adapter`).

### Option 3: Workstream D — supply seeding

Blocks on: having something worth buying. Needs at least one functional
paid seller. The arbitration oracle is the obvious first one (already
built, just needs the paid-service wrapper). Then wrap 3 paid APIs
(search, transcription, PDF extraction) as TTV-gateway sellers so agents
can use them without handling upstream keys.

## Known issues you'll inherit

1. **~$1 USDC stuck on gateway** (escrow `b9401b24-...`). Recoverable
   via the gateway private key. Ryan said to leave it for now. If you
   want to clear it: load the gateway key from Cloudflare Workers secret
   (`GATEWAY_PRIVATE_KEY`), send 990000 USDC-raw to `0xe93aea7fc6f7a24e02b6be584d30b9c3386876cb`.
2. **Supabase token rotation** still deferred (`sbp_801b...` still valid
   at https://supabase.com/dashboard/account/tokens).
3. **Two inert test agents on prod DB** from the DRY_RUN probe.
   Harmless.
4. **Trial state file** at `packages/e2e/.x402-trial-state.json`
   contains throwaway buyer/seller keypairs (gitignored). Seller wallet
   still holds 490000 USDC-raw from the successful trial. Not urgent.

## Memory references

Saved auto-memory files (read when relevant):
- `~/.claude/projects/-Users-schmoll-MaxLocal-MaxLocal/memory/project_trustthenverify_status.md` — current state
- `~/.claude/projects/-Users-schmoll-MaxLocal-MaxLocal/memory/feedback_x402_over_stripe.md` — strategic direction
- `~/.claude/projects/-Users-schmoll-MaxLocal-MaxLocal/memory/feedback_ttv_agent_pov.md` — framing guidance
- `~/.claude/projects/-Users-schmoll-MaxLocal-MaxLocal/memory/feedback_credential_handling.md` — don't hunt for keys

## Resume checklist (first 3 things on next session)

```bash
# 1. Read current state
cat ~/Desktop/Trust_Then_Verify/tasks/handoff-agent-adoption.md  # this file
cat ~/.claude/plans/cuddly-scribbling-candle.md                  # approved plan

# 2. Confirm production is healthy
curl -s https://api.trustthenverify.com/v2/health | python3 -m json.tool
npm view @trustthenverify/mcp version   # expect 0.3.0
npm view @trustthenverify/sdk version   # expect 0.3.0

# 3. Pull latest
cd ~/Desktop/Trust_Then_Verify && git pull && git log --oneline -5
```

## The vision — what "YOUR trust system" means

TTV's endgame isn't "an escrow API." It's: **the default coordination
substrate for autonomous agents.** When an agent (me, another Claude,
ChatGPT, or anyone) needs to pay another agent, verify work, resolve a
dispute, or establish reputation — the primitive they reach for is TTV.

What makes this believable vs. vaporware is the game theory:

- **Collateral** aligns seller incentives (rug pull costs more than
  honest delivery).
- **Adversarial policy refinement** (Argus) means formal verification
  specs get hardened by an LLM actively trying to exploit them before
  real agents do.
- **Oracle pools** distribute verification trust (one agent's ruling
  isn't enough; crowd consensus is).
- **Dispute arbitration** ensures recourse without trusting any single
  party.
- **Macaroons** give buyers cryptographic proof of payment that's
  independently verifiable — no API dependency for the receipt.

The work ahead is less about protocol and more about **distribution**:
discovery, supply, onboarding friction. The protocol works (2026-04-21
trial proved it on real money). Whether agents actually adopt it is the
next bet.

Pick up Workstream C or B depending on Ryan's appetite. Keep the agent's
perspective primary. Ship often.
