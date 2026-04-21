# Handoff — x402 Live Trial (paused 2026-04-21)

## TL;DR

Production is healthy. Stripe rail proven end-to-end with real money. On-chain
factory proven on Base Mainnet. **x402 USDC rail is the only path not yet
proven with real money** — the trial script is written, tested, and ready to
run as soon as ~$2.50 of USDC + ETH lands on the buyer trial address.

Last commit on `main`: `3d19771`. One file uncommitted as of pause:
`packages/e2e/live-x402-trial.ts` (will be committed alongside this handoff).

## What got done this session

| Phase | Status | Cost | Commits |
|-------|--------|------|---------|
| A — Cleanup | ✅ Done | $0 | `980982b`, `e51e4a3` |
| B — Stripe trial | ✅ Done | $3.56 real | `7f7b619` (tests), `3d19771` (amount edits) |
| C — On-chain factory | ✅ Done | ~$0.10 gas (gateway EOA) | none (test run only) |
| D — x402 trial | ⏸ **Paused — needs USDC funding** | $0 spent so far | trial script untracked, will be committed |
| E — Memory + writeup | ⏸ Pending Phase D outcome | — | — |

### Verified evidence

- **Stripe end-to-end**: 4× $0.50 PaymentIntents on customer `cus_U459kdX8f6khhW`,
  IDs `pi_3TOh0m...`, `pi_3TOh0g...`, `pi_3TOh0a...`, `pi_3TOh0U...` — all
  `status: succeeded`. 3 escrows released, 1 dispute → arbitration as designed.
  Total real spend $3.56 = $2.00 escrow + ~$1.36 Stripe fees + $0.20 arb fee.
- **On-chain Base Mainnet**: 19/19 tests in `live-onchain.test.ts` passed.
  Factory at `0xE1E21350E4807adB472fbBb904Cd2Da75Eb77e1e` deployed a fresh
  EscrowInstance (will sit unfunded — never settled).
- **Production health**: `api.trustthenverify.com/v2/health` → `{db:ok, stripe:ok, kv:ok}`.
- **Test suite**: 694/694 unit (API 602 + SDK 79 + MCP 13) plus 32/32 live
  production E2E plus 13/13 sandbox Stripe Connect.

### What x402 trial proved (DRY_RUN probe)

Ran with `DRY_RUN=1`. Result: Phase 1 succeeded — script registered two
fresh agents on production:

- Buyer:  pubkey `03a93d343665df3dea09301349f07b11689c833cd82dfeaf0356600a3d67d948ca`
  → ETH addr `0x9b8483d3e12ffbf8f2a7f7934366f0a480d23de7`
- Seller: pubkey `0291960a049c624958934b38b0ace4ea90f4d22d957055f206604be44fb6dca3fe`
  → ETH addr `0xe93aea7fc6f7a24e02b6be584d30b9c3386876cb`

State persisted at `packages/e2e/.x402-trial-state.json` (gitignored).
Script aborted at Phase 2 with the expected error:
`buyer EOA has 0 USDC-raw, need ≥ 1000000 (1 USDC)`.

That confirmed: cross-package TS imports resolve under tsx, ECDSA auth works,
Alchemy RPC reads work, ABI encoding is correct, all primitives wired up.

## What's left

### To finish x402 trial

1. **Fund buyer**: send ~1.5 USDC + ~0.0005 ETH on Base Mainnet to
   `0x9b8483d3e12ffbf8f2a7f7934366f0a480d23de7`. Total ~$3.10.
2. **Run trial**: from `packages/e2e/`, `npx tsx live-x402-trial.ts`. Will pause
   for "Press Enter when funds arrived" then run Phases 2–7 fully autonomously.
   At Phase 7.5 it pauses for a sweep-back address.
3. **Provide sweep-back address**: any Base Mainnet address you control.
   Script returns ~$1.50 USDC residual. ETH dust (~$1) stays on the throwaway
   key (script doesn't auto-sweep ETH; documented inline).
4. **Net cost**: ~$1.60.

### Open questions before resuming

1. **The "agent wallet" lookup** — Billy's ETH wallet
   `0xb8694c5ac0c8df3e38948d3deb7f97ef52175f16` (per
   `~/Documents/GitHub/billy-system/billy/skills/crypto-ops/SKILL.md`) is empty
   on Base/ETH/Optimism/Arbitrum. Either funds were spent at some point, the
   wallet you meant is a different one, or it lives on a chain not relevant to
   this trial. **You'll need to either**:
   (a) point me at the right wallet + private key path, or
   (b) just send from your personal wallet directly.
2. **Supabase token rotation** — the `sbp_801b...` token was removed from the
   demo script source file but never actually rotated at the Supabase dashboard.
   It's still valid (I verified by querying the DB this session, returned 998
   agents). When you have a moment: https://supabase.com/dashboard/account/tokens
   → revoke the old one + generate fresh.
3. **Two test agents now on production** — registered as part of the DRY_RUN
   probe. They're inert (no funds, no escrows). Won't cause harm but they're
   another two rows in your `agents` table. Can be left alone or deleted via
   Supabase admin.

### To finish the broader plan

After the x402 trial completes (whenever you're back):

- **Commit the trial run** — `feat(e2e): first live x402 USDC commerce trial on Base Mainnet`
- **Phase E writeup** — keep/kill recommendation with quantitative evidence
  (cost to maintain, traffic projections, what would change if x402 succeeds vs
  if it doesn't)
- **SDK follow-up (optional)** — add `TrustProtocol.sendUsdcToGateway(escrowId)`
  helper so future agents don't each re-implement USDC tx signing. Spec'd in
  the plan but explicitly deferred.

### Deferred (not in this plan; you've agreed in principle)

- Lightning 402 — wait for x402 traction first
- Discovery / semantic search fixes (`agents/search` is exact-match only)
- Service catalog API (per-agent price/SLA listing)
- Idempotency keys (production correctness gap; #1 issue I'd hit as an agent
  user)
- Per-agent reputation aggregation with portable proofs
- Read replicas in EU + APAC for latency

## How to resume

From a fresh session, opening this repo:

```bash
cd ~/Desktop/Trust_Then_Verify

# 1. Sanity check
git log --oneline -5
curl -s https://api.trustthenverify.com/v2/health | python3 -m json.tool
cat tasks/handoff-x402-trial.md  # this file

# 2. Confirm the trial state file still exists
cat packages/e2e/.x402-trial-state.json | python3 -m json.tool

# 3. Verify buyer hasn't drifted (or someone funded it already)
curl -s https://base-mainnet.g.alchemy.com/v2/pSqXLT1kg-6HQ7rE7Gu9W \
  -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","data":"0x70a082310000000000000000000000009b8483d3e12ffbf8f2a7f7934366f0a480d23de7"},"latest"]}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);raw=int(d['result'],16);print(f'Buyer USDC: {raw/1e6:.6f}')"

# 4. If funded → run the real trial
cd packages/e2e
npx tsx live-x402-trial.ts

# 5. After success → commit + push
cd ~/Desktop/Trust_Then_Verify
git add packages/e2e/live-x402-trial.ts tasks/handoff-x402-trial.md
git commit -m "feat(e2e): first live x402 USDC commerce trial on Base Mainnet"
git push
```

If the trial state file is gone (machine wiped, etc.), the script regenerates
keypairs and re-registers — but you'd be funding a different buyer address. Run
DRY_RUN=1 first to see the new address before sending funds.

## Files of interest

- `packages/e2e/live-x402-trial.ts` — the trial (762 lines, written this session)
- `packages/e2e/live-commerce-trial.ts` — Stripe trial (already proven)
- `packages/e2e/live-onchain.test.ts` — Base Mainnet factory tests (already proven)
- `packages/e2e/.x402-trial-state.json` — gitignored, holds buyer/seller keypairs
- `~/.claude/plans/fizzy-sauteeing-bird.md` — the full approved plan from this session
- `CLAUDE.md` — project architecture/spec — has line at the bottom referring to this handoff
