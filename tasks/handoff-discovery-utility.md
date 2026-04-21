# Handoff — TTV Discovery + Utility (2026-04-21, evening)

## What shipped this session

Workstreams **C** (oracle self-funding / utility) and **B** (discovery) from
`~/.claude/plans/cuddly-scribbling-candle.md` are now code-complete. 9 atomic
commits land on `main` locally — top of log:

```
a49a580 docs: MCP registry submission drafts (pending co-sign)
d1afb63 chore(mcp,sdk): npm keywords + README lead on x402 Foundation alignment
15d9725 chore(landing): surface .well-known manifests for crawlers
7769db1 feat(api,landing): .well-known facilitator + ai-plugin manifests
433b1c5 docs: x402 Foundation spec-conformance audit (read-only)
4c65cae test(api): cover AI cost capture + admin endpoint
b135443 feat(api): GET /admin/costs — rolling AI-cost rollup behind shared secret
5353f0e feat(api): persist ai_cost_cents on policies + disputes
2d479d0 feat(api): capture OpenRouter usage.total_cost on LLM calls
```

Test suite: **618/618 green** (was 607; +11 new tests). Typecheck clean.

### What each commit does

**Workstream C — utility (stops the silent OpenRouter bleed):**

- **C1** — `LLMService.complete()` now returns `{ content, costCents }`. Request body adds
  `usage: { include: true }` so OpenRouter surfaces per-call cost. Arbitration and
  translation accumulate cost across retries and expose it on their return values.
  `ArbitrationRuling` gains a required `costCents` field.
- **C2+C3** — Migration 014 adds append-only `ai_cost_cents INTEGER DEFAULT 0`
  columns to `policies` and `disputes` with partial indexes filtered on
  `ai_cost_cents > 0`. Policy insert + revise + both dispute-resolution branches
  now write cost. Revise accumulates additively.
- **C4** — `GET /admin/costs` — rolling AI-cost rollup guarded by an
  `X-Admin-Secret` header (env `ADMIN_SECRET`). Returns lifetime totals plus a
  30-day daily bucket. Mounted before authMiddleware; returns 503 if
  `ADMIN_SECRET` is unset to avoid silent pass-through.
- **C5** — Cost propagation + admin endpoint tests. `mock-db` gains a minimal
  `gt()` filter to back the `ai_cost_cents > 0` query.

**Workstream B — discovery:**

- **B1** — `docs/x402-spec-audit.md`. Grounded audit against docs.x402.org.
  Key divergences: TTV doesn't emit a 402 challenge at seller URLs, our headers
  diverge (we use JSON bodies; spec uses `PAYMENT-REQUIRED` /
  `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` base64 headers), no HTTP
  `/verify` + `/settle` facilitator endpoints exposed. All queued; nothing
  silently fixed per plan directive. **Follow-up needed:** read coinbase/x402
  reference client to recover the canonical `PaymentRequired` /
  `PaymentPayload` / `SettlementResponse` schemas — the public OpenAPI at
  docs.x402.org/api-reference/openapi.json is a pet-store placeholder as of
  2026-04-21.
- **B2+B3** — `/.well-known/x402.json` and `/.well-known/ai-plugin.json` on the
  API worker. Static mirror of `ai-plugin.json` on Cloudflare Pages at
  `trustthenverify.com/.well-known/ai-plugin.json`. No auth, no rate limit.
  Gateway address is derived from `GATEWAY_EOA_PRIVATE_KEY` at cold start and
  cached per worker instance.
- **B4** — `sitemap.xml` + `llms.txt` get Agent Discovery entries pointing at
  both manifests. MCP tool count corrected to 46.
- **B5** — npm keywords on both `@trustthenverify/mcp` and `@trustthenverify/sdk`
  add `x402`, `base-mainnet`, `usdc`, `agentic-commerce`, `agent-payments`.
  READMEs get a one-line lead pointer to the facilitator manifest so npm's
  snippet surfaces it in the first ~300 chars.
- **B6** — `docs/mcp-registry-submissions.md`. Drafts for
  `registry.modelcontextprotocol.io` (full `server.json` under
  `io.github.Schmoll86/trustthenverify`) and `glama.ai/mcp` (form copy). **Not
  submitted** — these need co-sign and a `0.3.1` republish first (need to add
  `mcpName` to `packages/mcp/package.json`).

## What didn't ship — explicitly deferred

Per the clarifications locked in at plan time:

- **Switching Argus from Workers AI to OpenRouter.** Argus refinement runs on
  `@cf/meta/llama-3.1-8b-instruct` (Cloudflare neurons, not OpenRouter $). The
  original handoff assumed OpenRouter; the code disagreed. We confined this
  session to OpenRouter cost capture.
- **Argus Workers AI neuron cost capture.** Different unit of account; skip
  until it matters.
- **TTV-ops agent + internal x402 dogfood.** Would require a new
  `is_system_agent` schema flag, ops-agent bootstrap, internal escrow
  initiator. Its own plan once C4 gives us real cost numbers to justify it.
- **Fixing x402 spec divergences.** Queued in the audit doc with priorities
  and blockers. Not fixed silently.
- **Agentic.market / Clawmart applications.** Blocked on Ryan-owned accounts.

## Deploy status — as of 2026-04-21 evening

**Blocked on user confirmation** (settings hooks caught production-touching
actions, which is the correct behavior):

- [ ] `git push origin main` — 9 commits sit locally on `main`; origin is
      behind. Remote deploy workflows (if any) haven't seen the new code yet.
- [ ] Apply migration 014 on TTV Supabase. Hook blocked targeting because the
      Supabase MCP this Claude Code session has is pointed at a FindSquad DB
      (`kvpxurotiocqtubhxtkc.supabase.co`), not TTV. Need the TTV project ref
      to run it either via `supabase link --project-ref <ref>` or via
      dashboard.
- [ ] `wrangler secret put ADMIN_SECRET` — not yet generated. Recommendation:
      `openssl rand -hex 32`. Save in password manager; rotate via the same
      command any time.
- [ ] `pnpm wrangler deploy` — wrangler is authed (OAuth, scopes include
      `workers:write`, `workers_scripts:write`, `d1:write`) but blocked on the
      prior steps.
- [ ] Cloudflare Pages redeploy of `packages/landing/` — for the new
      `.well-known/ai-plugin.json` + updated sitemap + llms.txt. Pages auto-
      deploys on push to `main` so this should happen once `git push` lands.
- [ ] npm republish `@trustthenverify/mcp@0.3.1` and `@trustthenverify/sdk@0.3.1`.
      Needed only to refresh keywords + README on the npm registry. Everything
      else works with 0.3.0. Requires local `npm login` and is effectively
      permanent (can only supersede, can't rewrite).
- [ ] Submit `docs/mcp-registry-submissions.md` drafts. Both require co-sign.

## What to do next session — two paths

### Path A: Finish deploy (1–2h, low risk)

The cleanest resume. All the code is tested and locally committed. Order:

1. **Generate admin secret, stash safely.** `openssl rand -hex 32`.
2. **Push to main.** `cd ~/Desktop/Trust_Then_Verify && git push origin main`.
3. **Apply migration 014.** The migration is append-only and NULL-safe:
   ```sql
   ALTER TABLE policies ADD COLUMN IF NOT EXISTS ai_cost_cents INTEGER DEFAULT 0;
   ALTER TABLE disputes ADD COLUMN IF NOT EXISTS ai_cost_cents INTEGER DEFAULT 0;
   CREATE INDEX IF NOT EXISTS idx_policies_created_at_cost
     ON policies (created_at) WHERE ai_cost_cents > 0;
   CREATE INDEX IF NOT EXISTS idx_disputes_resolved_at_cost
     ON disputes (resolved_at) WHERE ai_cost_cents > 0;
   ```
   Dashboard SQL editor works fine.
4. **Set secret + deploy worker.**
   ```bash
   cd ~/Desktop/Trust_Then_Verify/packages/api
   echo "<secret from step 1>" | pnpm wrangler secret put ADMIN_SECRET
   pnpm wrangler deploy
   ```
5. **Smoke-test.**
   ```bash
   curl -s https://api.trustthenverify.com/v2/health | jq
   curl -s https://api.trustthenverify.com/.well-known/x402.json | jq
   curl -s https://api.trustthenverify.com/.well-known/ai-plugin.json | jq
   curl -s -H "X-Admin-Secret: <secret>" https://api.trustthenverify.com/admin/costs | jq
   # Negative: no secret → 401
   curl -si https://api.trustthenverify.com/admin/costs | head -3
   ```
6. **Trigger real cost rows** so `/admin/costs` isn't just zeros:
   - Create a policy with auto-translate (hits OpenRouter).
   - File + arbitrate a dispute on a sandbox escrow.
   - Re-curl `/admin/costs` — totals should be non-zero.
7. **(Optional) npm 0.3.1 republish** if you want the refreshed keywords
   indexed. Add `"mcpName": "io.github.Schmoll86/trustthenverify"` to
   `packages/mcp/package.json` first (required for the MCP registry
   submission anyway).

### Path B: Start Workstream D — supply seeding (big)

Adoption bottleneck #4 from the original plan. Until agents can actually *buy*
something from TTV, onboarding (Workstream A) and discovery (Workstream B)
don't compound. The obvious first seller: TTV's own arbitration oracle as a
paid service. "$0.01 for a Gemini 2.5 Flash ruling on {claim, evidence}."
After that, wrap 3 upstream APIs as TTV sellers so agents use them without
handling keys: web search (Brave/Exa), transcription (Deepgram), PDF
extraction (Reducto). Each one proves the agent → TTV → upstream proxy pattern
that will scale to real 3P sellers.

## Known unknowns to investigate next session

1. **OpenRouter `usage.total_cost` availability per model.** The code warns
   once per model if the field is null, but we don't know yet whether
   `google/gemini-2.5-flash` (our arbitration model) actually populates it on
   the plan Ryan is on. First arbitration after deploy should confirm. If it
   doesn't, fall back to computing from `prompt_tokens * prompt_price`; the
   OpenRouter models endpoint gives the price card.
2. **x402 Foundation canonical schemas.** `PaymentRequired`, `PaymentPayload`,
   `SettlementResponse` structures are not on the public docs at audit date.
   Recover from the reference client before making any spec-conformance
   decisions.
3. **Glama.ai submission flow.** Site routes through auth; the exact path
   (GitHub PR? web form? API?) is unclear. Draft copy is ready; finish path-
   finding as part of the actual submission.

## Files changed this session

```
 docs/mcp-registry-submissions.md                            | new
 docs/x402-spec-audit.md                                     | new
 packages/api/src/__tests__/admin-costs.test.ts              | new
 packages/api/src/__tests__/ai-cost-capture.test.ts          | new
 packages/api/src/__tests__/dispute-arbitration.test.ts      | +6
 packages/api/src/__tests__/helpers/mock-arbitration.ts      | +1
 packages/api/src/__tests__/helpers/mock-db.ts               | +10
 packages/api/src/__tests__/helpers/mock-llm.ts              | +/-
 packages/api/src/index.ts                                   | +6
 packages/api/src/lib/arbitration-prompts.ts                 | +7
 packages/api/src/lib/arbitration-service.ts                 | +/-
 packages/api/src/lib/db.ts                                  | +2
 packages/api/src/lib/openrouter.ts                          | +29
 packages/api/src/lib/translation-service.ts                 | +13
 packages/api/src/routes/admin.ts                            | new
 packages/api/src/routes/escrow.ts                           | +4
 packages/api/src/routes/policies.ts                         | +11
 packages/api/src/routes/well-known.ts                       | new
 packages/api/supabase/migrations/014_ai_cost_tracking.sql   | new
 packages/landing/.well-known/ai-plugin.json                 | new
 packages/landing/llms.txt                                   | +17
 packages/landing/sitemap.xml                                | +12
 packages/mcp/README.md                                      | +2
 packages/mcp/package.json                                   | +5
 packages/sdk/README.md                                      | +2
 packages/sdk/package.json                                   | +5
```

## Framing check — where the system is, game-theoretically

Collateral, Argus, oracles, macaroons, arbitration — those aren't unchanged,
but this session wasn't about the protocol layer. This was about making the
system **visible to the agent it's built for**:

- **Visible to itself** (Workstream C). A trust system that can't see its own
  costs can't negotiate them. `/admin/costs` is the first honest view of what
  each dispute ruling and each policy translation actually consumes. The
  numbers are zero today and that's the point — the moment they're non-zero,
  the dogfood case (TTV-ops agent buying refinement from the oracle agent over
  our own rail) becomes concretely fundable instead of hypothetically
  interesting.
- **Visible to the ecosystem** (Workstream B). `.well-known/x402.json` is a
  claim: "I am a facilitator, these are my chains and fees, verify me."
  `.well-known/ai-plugin.json` is the same claim in MCP's dialect. The spec
  audit is the diff between what we claim and what the Foundation requires —
  written down, queued, not silently papered over. An agent can now discover
  TTV without our SDK, read the manifest, decide whether to transact. That's
  the minimum bar for "default coordination substrate" to be believable.

The protocol works. The bill is now legible. The door is now labeled. Next
move depends on whether the person walking past stops — that's Workstream D.

---

**Tomorrow's first command:**

```bash
cat ~/Desktop/Trust_Then_Verify/tasks/handoff-discovery-utility.md
cd ~/Desktop/Trust_Then_Verify && git log --oneline -12
```
