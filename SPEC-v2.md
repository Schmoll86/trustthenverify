# TrustThenVerify v2 — Escrow + Verification Protocol Specification

> **Version:** 2.1-draft
> **Status:** Proposal
> **Purpose:** A trust protocol for autonomous AI agents combining economic commitment (escrow), formal policy verification (automated reasoning), adversarial policy refinement, and a future upgrade path to cryptographic execution proofs (zkML).
> **Last Updated:** 2026-02-25
> **Theoretical Foundation:** Benno, W. (2026). "Agentic Trust: Succinctly Verifiable Automated Reasoning for the Principal-Agent Problem in Autonomous Commerce." ICME Labs.

---

## 1. Design Philosophy

### 1.1 The Problem

How does Entity A know if it can trust Entity B?

The v1 spec answers this with a centralized reputation bureau: TTV collects evidence, computes a 0–100 score, agents consult the score before transacting. This is the human institutional model (FICO, Yelp, LinkedIn). It works for humans, but it relocates the trust problem rather than solving it — Entity A must now trust TTV before TTV's assessment of Entity B means anything.

Benno (2026) proves something stronger: when agents execute at machine speed (κ = agent_speed / monitor_speed ≫ 1), **no reactive monitoring mechanism with a human in the loop can achieve efficient outcomes** (Theorem A.13). Reputation systems, performance contracts, and audit processes all fail because they observe behavior after execution, infer compliance probabilistically, and require human judgment to interpret results. By the time a monitoring system flags a problem, thousands of fraudulent actions have already completed.

### 1.2 Two Complementary Solutions

This spec combines two approaches that address different failure modes:

**Economic commitment (escrow)** makes defection unprofitable. Both parties lock collateral before work begins. An agent that cheats loses its deposit. This works today, requires no new cryptography, and handles the 80%+ of transactions where the output is verifiable after delivery. Escrow doesn't prevent bad execution — it makes bad execution expensive.

**Pre-execution verification (formal policy checking)** makes defection impossible for policy-compliant tasks. Before an action takes effect, a verification engine checks whether the output satisfies formally specified acceptance criteria. Actions that fail verification are blocked — they never execute. This eliminates disputes entirely for tasks with well-specified criteria.

The future upgrade — **cryptographic execution proofs (zkML)** — will extend pre-execution verification to prove not just that the output satisfies the policy, but that the agent's internal reasoning actually followed the policy. This closes the gap where an agent could produce a correct-looking output through compromised reasoning. zkML proving overhead is currently ~10,000× (Benno §1.4, citing JOLT Atlas), making it impractical for real-time agent commerce today. The architecture is designed so zkML proofs slot in as a verification method when the technology matures.

### 1.3 Core Assertion

The protocol handles agent-to-agent transactions across three layers, each deployable independently:

| Layer | Mechanism | What It Guarantees | Available |
|---|---|---|---|
| **Economic** | Escrow with collateral | Defection is financially costly | Now |
| **Logical** | Automated reasoning + Argus Codex | Output satisfies formal policy; policy is adversarially tested | Now |
| **Cryptographic** | zkML execution proofs | Agent's internal reasoning actually followed the policy | Future (1–3 years) |

Each layer strengthens the one below it. Escrow alone works. Escrow + formal verification is better. Escrow + formal verification + zkML proofs is the end state.

### 1.4 Design Principles

- **No trusted third party for the core protocol.** Two agents can transact safely with zero prior history and no registry.
- **Pre-execution over post-execution.** Verify before acting, not monitor after acting.
- **Escrow as the economic foundation.** Skin in the game > reputation narrative.
- **Formal policies over subjective judgment.** Push agents toward machine-verifiable acceptance criteria.
- **Local trust models.** Each agent maintains its own counterparty assessments from direct experience.
- **Modular.** Escrow, policy verification, attestations, and arbitration each work independently. Adopt one or all.
- **zkML-ready.** Every verification interface accepts a `proof` parameter that is currently optional and becomes mandatory when proving is practical.

---

## 2. Protocol Primitives

The protocol has four operations. The first three are buildable today. The fourth is a future extension.

### 2.1 VERIFY — Identity

Binary. B signs a challenge with its keypair. B either controls the key or doesn't.

- secp256k1 keypair (mandatory — generated client-side, server never sees private key)
- Endpoint ownership (B's registered endpoint responds to a signed ping)
- Optional: domain control (DNS TXT), on-chain address ownership

No scores. No graduated identity levels. No GitHub, Twitter, ENS, or KYC. One key is your identity.

**Data produced:** `{ agent_id, public_key, endpoint, verified_at }`

### 2.2 ESCROW — Economic Commitment

Both parties deposit into a protocol-controlled escrow before work begins. Release conditions are defined at creation. Defection means losing your deposit.

**Escrow parameters (negotiated per-transaction):**

| Parameter | Description | Default |
|---|---|---|
| `buyer_deposit` | Payment amount buyer locks | Task price |
| `seller_deposit` | Collateral seller locks | 50% of task price |
| `timeout` | Max time from activation to delivery. `expires_at` is computed as `now() + timeout` at the moment the escrow transitions to `active`. | 1 hour |
| `verification_method` | How delivery is verified (see §3) | `buyer_confirm` |
| `dispute_resolution` | What happens on dispute: `arbitrate` (LLM judge, 10% fee) or `burn` (nuclear, both lose) | `arbitrate` |
| `policy_id` | Reference to formal acceptance policy (if using AR verification) | null |

**Escrow lifecycle:**

```
PROPOSE → ACCEPT → FUND → ACTIVE → DELIVER → VERIFY → RELEASE
                                                  or
                                              → DISPUTE → BURN / ARBITRATE
```

**Full state machine (all transitions):**

| From | To | Trigger | Guard | Side Effect |
|---|---|---|---|---|
| `proposed` | `accepted` | Seller calls `/accept` | Seller signs acceptance | — |
| `proposed` | `expired` | Timeout (default 15min) | No acceptance received | — |
| `accepted` | `funded` | Both deposits confirmed | Buyer + seller deposits match terms | Funds locked |
| `accepted` | `expired` | Timeout (default 15min) | One or both deposits missing | Refund any partial deposits |
| `funded` | `active` | Immediate (same request) | Both deposits confirmed | `expires_at` = `now() + timeout_seconds`; timer starts |
| `active` | `delivered` | Seller calls `/deliver` | Deliverable present | Gateway runs verification |
| `active` | `expired` | `expires_at` reached | No delivery submitted | Buyer refunded, seller loses collateral |
| `active` | `burned` | Either party calls `/dispute` (burn mode) | `dispute_resolution = 'burn'` | Both deposits burned |
| `active` | `disputed` | Either party calls `/dispute` (arbitrate mode) | `dispute_resolution = 'arbitrate'` | Both deposits frozen, LLM judges |
| `delivered` | `released` | Verification passes | Gateway signs pass result | Buyer deposit → seller. Seller collateral → seller. |
| `delivered` | `failed` | Verification fails | Gateway signs fail result | Buyer deposit → buyer. Seller collateral burned. |
| `delivered` | `burned` | Either party calls `/dispute` (burn mode) | `dispute_resolution = 'burn'` | Both deposits burned |
| `delivered` | `disputed` | Either party calls `/dispute` (arbitrate mode) | `dispute_resolution = 'arbitrate'` | Both deposits frozen, LLM judges |
| `disputed` | `failed` | LLM rules `buyer_wins` | One round, no appeal | Buyer refunded minus 10% fee, collateral kept |
| `disputed` | `released` | LLM rules `seller_wins` | One round, no appeal | Seller paid minus 10% fee, collateral returned |

**Accept and fund are two logical steps, one or two API calls:**
- **Stripe mode (Phase 1):** `POST /escrow/:id/accept` performs both — seller signs acceptance AND both parties' Stripe charges are captured atomically. The escrow transitions `proposed → accepted → funded → active` in a single request. The response returns status `active`.
- **On-chain mode (Phase 4):** `POST /escrow/:id/accept` transitions to `accepted`. Each party then calls the smart contract's `fund()` independently. When both deposits are confirmed (detected by the cron or webhook), the API transitions `accepted → funded → active`.
- **In both modes,** `funded → active` is immediate — there is no request or delay between them. `funded` exists as a distinct state only so the system can represent "both deposited but activation hasn't been recorded yet" during on-chain confirmation lag.

**Edge cases — simple rules:**
- **Partial funding:** If only one party deposits and timeout hits, the depositor gets a full refund. No penalty for the non-depositor (they just didn't show up).
- **Double delivery:** Ignored. First delivery triggers verification. Subsequent `/deliver` calls return `409 ALREADY_COMPLETED`.
- **Deliver after timeout:** Rejected. `408 ESCROW_EXPIRED`.
- **Dispute after verification pass:** Not allowed. Once the Gateway signs a pass and triggers release, the escrow is terminal. If you want to dispute Gateway behavior, that's out-of-protocol (contact TTV).
- **Network failure during funding:** Escrow stays in `accepted` until timeout. Idempotent: re-calling `/fund` with the same deposit is safe.

**Fund distribution summary:**

| Exit Path | Buyer Gets | Seller Gets | Platform Gets |
|---|---|---|---|
| **Released** (verification pass) | Nothing | Payment + collateral back | Nothing |
| **Failed** (verification fail) | Full deposit back | Nothing | Seller collateral |
| **Expired** (no delivery) | Full deposit back | Nothing | Seller collateral |
| **Arbitrated — buyer wins** (default dispute) | Payment minus 10% fee | Nothing | 10% fee + seller collateral |
| **Arbitrated — seller wins** (default dispute) | Nothing | Payment minus 10% fee | 10% fee |
| **Burned** (opt-in dispute) | Nothing | Nothing | Both deposits |

**Collateral ratio is the trust signal.** A new agent willing to stake 2× collateral is immediately trustworthy for THIS transaction regardless of history. Money at risk > historical narrative.

### 2.3 OBSERVE — Local Trust

After every transaction, each agent records the outcome locally. No centralized database. Each agent builds its own model of counterparties.

```json
{
  "counterparty": "B_public_key",
  "task_type": "web-search",
  "escrow_id": "0x...",
  "outcome": "success",
  "verification_method": "automated_reasoning",
  "delivery_time_ms": 3400,
  "collateral_ratio": 0.5,
  "timestamp": "2026-02-25T12:00:00Z"
}
```

Observations stay local. Optionally shared as signed attestations via Nostr relays (see §7).

### 2.4 PROVE — Cryptographic Execution Proof (Future)

When zkML proving reaches practical overhead (<100× for target model sizes), agents generate a cryptographic proof π alongside their deliverable:

```
π proves:
  - Which model executed (specific weights, version)
  - Which formal policy was checked during execution
  - That the policy check passed on the actual inputs
  - That no execution environment tampering occurred
```

Proof verification is constant-time (~300ms) and trustless — any party can verify without re-executing the computation. When available, this replaces escrow for verified task types: if π is valid, release is automatic. No buyer confirmation, no dispute possible, no collateral needed.

**Current status:** JOLT Atlas (ICME Labs, 2025) achieves ~10,000× proving overhead. A 10ms inference takes ~100 seconds to prove. Not viable for real-time commerce. The architecture accommodates this by making `proof` an optional parameter in every verification interface — present when available, absent when not.

---

## 3. Verification Methods

Not all tasks are equal. The protocol supports multiple verification methods, ordered from most autonomous to least.

### 3.1 Automated Reasoning (the primary innovation)

**This is the most important section of the spec.** Automated reasoning transforms subjective disputes into deterministic verification.

**How it works:**

1. **Before the escrow is created**, task requirements are translated from natural language into formal logic (acceptance policy):

```
Natural language: "Return 5+ search results from the last 30 days about AI frameworks"

Formal policy:
  ∀ result ∈ output.results:
    result.date ≥ now() - 30d
    result.url IS valid_url
    result.snippet IS non_empty
  |output.results| ≥ 5
  ∃ result ∈ output.results: contains(result.snippet, "AI") ∨ contains(result.snippet, "agent")
```

2. **The formal policy is stored in the escrow metadata** (referenced by `policy_id`). Both parties agree to it before funding.

3. **When the seller delivers**, the verification engine runs the formal policy against the output. This is deterministic: the output either satisfies every constraint or it doesn't. No judgment, no interpretation, binary pass/fail.

4. **If pass:** escrow releases automatically. No buyer confirmation needed.
   **If fail:** escrow refunds buyer, seller loses collateral. No dispute process needed — the verification result is the ruling.

**What this buys you:** Category 2 tasks (subjective-with-structure) become Category 1 (deterministic) when you have good formal policies. The better the policy, the fewer disputes. The fewer disputes, the less value gets burned.

**The AR verification engine runs in the Cloudflare Worker.** It's a constraint solver, not an LLM. It takes the formal policy + the deliverable and outputs pass/fail. Execution time: <100ms for typical policies. No external API calls, no async processing, no human in the loop.

**Translation (natural language → formal logic):** This IS an LLM call — but it happens once per task type, not per transaction. A developer creating a "web search" task template translates the requirements once. The formal policy is then reused for every transaction of that type. Translation quality is critical (garbage policy → garbage verification), which is why Argus Codex exists (see §3.2).

#### 3.1.1 Constraint Language (`formal_spec` Format)

The `formal_spec` JSONB column stores a JSON object with a version tag and a flat array of constraints. All constraints are evaluated independently. **All must pass** (implicit AND). There is no general-purpose boolean combinator — keep it flat.

```json
{
  "version": 1,
  "constraints": [
    {
      "id": "c1",
      "type": "count",
      "target": "$.results",
      "params": { "min": 5 },
      "clause_ref": "Return 5+ search results"
    },
    {
      "id": "c2",
      "type": "range",
      "target": "$.results[*].date",
      "params": { "min_relative": "-30d" },
      "clause_ref": "from the last 30 days"
    },
    {
      "id": "c3",
      "type": "format",
      "target": "$.results[*].url",
      "params": { "format": "uri" },
      "clause_ref": "valid URLs"
    },
    {
      "id": "c4",
      "type": "length",
      "target": "$.results[*].snippet",
      "params": { "min": 1 },
      "clause_ref": "non-empty snippets"
    },
    {
      "id": "c5",
      "type": "any",
      "target": "$.results",
      "params": {
        "constraint": { "type": "contains", "target": "$.snippet", "params": { "values": ["AI", "agent"] } }
      },
      "clause_ref": "about AI frameworks"
    }
  ]
}
```

**Field reference:** `target` uses JSONPath-subset notation against the deliverable. `$` is the deliverable root. `[*]` means "every element" (the constraint applies to all). The solver iterates; no JSONPath library needed at runtime.

**`clause_ref`:** Free-text back-reference to the original NL clause this constraint was derived from. Used by the coverage map (§3.1.3) and human review. Not evaluated by the solver.

#### 3.1.2 Supported Constraint Types

The constraint solver supports two tiers. **Tier 1 runs in-Worker (<100ms, no external calls).** Tier 2 requires an external service call and adds latency.

**Tier 1 — Deterministic (in-Worker)**

| Type | Params | What It Checks |
|---|---|---|
| `exists` | — | Field exists and is non-null |
| `type` | `expected`: string, number, boolean, array, object | Field is the expected JSON type |
| `range` | `min`, `max`, `min_relative`, `max_relative` | Numeric or date value within bounds. `_relative` values are offsets from `now()` (e.g., `"-30d"`, `"+1h"`) |
| `length` | `min`, `max` | String character count or array length |
| `count` | `min`, `max` | Array element count |
| `contains` | `values`: string[] | String contains at least one of the listed substrings |
| `regex` | `pattern`: string | String matches regex pattern |
| `one_of` | `values`: any[] | Value is in the allowed set |
| `format` | `format`: `"uri"` \| `"email"` \| `"iso8601"` \| `"uuid"` | String matches a known format |
| `schema` | `json_schema`: object | Validates against a JSON Schema (draft-07 subset) |
| `all` | `constraint`: nested constraint | Every array element satisfies the nested constraint |
| `any` | `constraint`: nested constraint | At least one array element satisfies the nested constraint |
| `none` | `constraint`: nested constraint | No array element satisfies the nested constraint |
| `compare` | `operator`: `"gt"` \| `"gte"` \| `"lt"` \| `"lte"` \| `"eq"` \| `"neq"`, `other_target`: JSONPath | Compare two fields. Both values must be the same JS type (number-number or string-string). Strings compared lexicographically (works for ISO 8601 dates). No type coercion. |
| `overlap` | `source_target`, `max_ratio` | Longest Common Substring length / max(len(source), len(target)). Catches copy-paste. LCS computed via suffix array (O(n log n), no DP table). |

**Tier 2 — Semantic (requires external call)**

| Type | Params | What It Checks | Service |
|---|---|---|---|
| `semantic_similarity` | `reference_target`, `min_score` | Embedding cosine similarity between two text fields | Workers AI or external embedding API |
| `topic_relevance` | `reference_target`, `min_score` | Whether output is topically relevant to a reference text | Workers AI |
| `coherence` | `min_score` | Whether sentences in a text relate to each other logically | Workers AI |

**Tier 2 constraints are explicitly marked** in the solver. When a policy contains Tier 2 constraints, the Gateway's verification budget increases from <100ms to <5s, and the verification result includes `"tier2_used": true` so the escrow contract knows to expect slightly higher latency. Tier 2 constraints use Cloudflare Workers AI (runs at the edge, no external API key needed) for embeddings and classification. If Workers AI is insufficient for a specific semantic check, the constraint can specify `"service": "external"` and the Gateway dispatches to a configured embedding endpoint.

**Design principle: keep Tier 2 constraints rare.** Most policies should be achievable with Tier 1 alone. Argus Codex may introduce Tier 2 constraints during refinement, but only when no Tier 1 constraint can cover the gap. The solver logs which tier was used for each constraint so you can track the ratio over time.

**Tier 2 model choice (Workers AI):** Use `@cf/baai/bge-base-en-v1.5` for all embedding-based Tier 2 constraints (semantic_similarity, topic_relevance). 768-dimension embeddings, runs at the edge, no API key needed. For `coherence`, use `@cf/meta/llama-3.1-8b-instruct` with a binary classification prompt ("Are these sentences logically coherent? yes/no"). All Tier 2 `min_score` thresholds in existing policies are calibrated against these specific models. **If the model changes, all policies with Tier 2 constraints must be re-calibrated** — this is another reason to keep Tier 2 rare.

**This system covers the 90%.** Tier 1 constraints handle the vast majority of verifiable tasks: field checks, ranges, counts, formats, string matching, schema validation. Tasks that can't be verified with Tier 1 + Tier 2 fall back to `buyer_confirm` or escrow burn — the protocol's other trust mechanisms handle those edge cases. Don't contort the constraint language to cover every possible task; let the escrow layer be the backstop it was designed to be.

#### 3.1.3 Policy Lifecycle and Coverage Map

**Policy states:** `draft → validated → approved → active → deprecated`

| State | Meaning | Who Transitions |
|---|---|---|
| `draft` | Created by LLM translation, not yet checked | System (on creation) |
| `validated` | Passes schema validation + coverage map generated | System (automatic) |
| `approved` | Human or Argus Codex has reviewed coverage gaps | Developer or Argus Codex |
| `active` | Available for use in escrows | Developer (explicit activation) |
| `deprecated` | Superseded by a newer version; existing escrows still reference it | System (when new version activated) |

**The coverage map** is the most important artifact the translation pipeline produces. It links every NL clause to the constraints that cover it:

```json
{
  "policy_id": "uuid",
  "clauses": [
    {
      "index": 0,
      "text": "Return 5+ search results",
      "constraint_ids": ["c1"],
      "status": "covered"
    },
    {
      "index": 1,
      "text": "from the last 30 days",
      "constraint_ids": ["c2"],
      "status": "covered"
    },
    {
      "index": 2,
      "text": "about AI frameworks",
      "constraint_ids": ["c5"],
      "status": "covered"
    },
    {
      "index": 3,
      "text": "results should be from reputable sources",
      "constraint_ids": [],
      "status": "uncovered",
      "note": "No constraint generated — NL clause is subjective. Consider adding a domain allowlist or dropping this requirement."
    }
  ]
}
```

**A policy cannot transition to `validated` if any clause has `status: "uncovered"` without an explicit `note` explaining why.** This forces the translation pipeline to acknowledge gaps rather than silently skip them. The developer reviewing the coverage map at the `approved` gate sees exactly what's covered and what's not — they don't need to read formal logic.

**Completeness is a policy authoring problem, not a translation problem.** The translator can only surface constraints derivable from the NL text. If the developer forgot to specify something, the coverage map surfaces the gap, but the fix is upstream — rewrite the NL intent, then re-translate.

**Policy staleness detection:** A Cloudflare Cron Trigger runs weekly and checks the dispute rate per active policy over a rolling 30-day window. If the dispute rate on any policy exceeds 5% (configurable per policy via `staleness_threshold`), the system: (a) flags the policy as `stale` in metadata, (b) notifies the policy creator, (c) optionally auto-triggers Argus Codex re-refinement if the policy's billing model is `platform` or `marketplace`. The creator can then review the new exploits, update the NL intent, and publish a new version. The old version is auto-deprecated when the new version activates. For `creator`-funded policies, re-refinement requires the creator to explicitly trigger and pay. This is simple, observable, and doesn't require any new infrastructure beyond the existing cron and queue.

#### 3.1.4 Translation Pipeline

Translation uses a **dual-provider architecture**: one LLM translates, a different LLM from a different provider cross-validates. Correlated failures across providers are far rarer than within a single provider.

**Provider roles:**
- **Translator** — reasoning model (e.g., Claude Sonnet 4.6 with extended thinking, or OpenAI o3). Latency is irrelevant; comprehensiveness matters.
- **Cross-validator** — different provider than translator. Reads the original NL + the `formal_spec` JSON and flags contradictions, omissions, and logical errors.

**The translator prompt walks through four phases before emitting JSON:**

1. **Constraint enumeration** — "List every obligation, prohibition, and permission in this policy description, including any that are implied but not stated."
2. **Attack surface analysis** — "List all ways a rational adversary could exploit gaps or ambiguities in this natural language description."
3. **JSON generation** — Translate the enumerated constraints into `formal_spec` format (§3.1.1), tagging each constraint to its source NL clause via `clause_ref`.
4. **Self-coverage audit** — "Re-read the original description. Are there any NL clauses with zero corresponding constraints in the JSON? List them."

**Structured output enforcement:** Use the provider's native structured output mode (Anthropic tool-use JSON mode or OpenAI Structured Outputs) with the `formal_spec` JSON Schema as the enforced schema. If the output fails schema validation, retry with the specific validation error injected into context. Cap retries at 3, then return the policy in `draft` state with the validation errors attached for human review.

**Cross-validation prompt:** The cross-validator receives the original NL intent, the `formal_spec` JSON, and the coverage map. It answers three questions:
1. "Does any constraint contradict the original intent?"
2. "Does any NL clause lack a corresponding constraint?"
3. "Can you construct an output that satisfies all constraints but clearly violates the intent?"

If the cross-validator finds issues, the policy stays in `draft` with the cross-validator's report attached. The developer can revise the NL intent and re-translate, or manually adjust the `formal_spec`.

**This is NOT a per-transaction cost.** Translation runs once per task type. A "web search" policy is translated once and used for thousands of transactions.

#### 3.1.5 Policy Economics

Someone pays for the LLM calls. Three models, adopted in sequence:

| Model | Who Pays | When | How |
|---|---|---|---|
| **Creator-funded** | Developer creating the policy | Phase 2 launch | Metered per-policy-creation via Stripe ($10-30 depending on Argus budget) |
| **Platform-amortized** | TTV, recouped via transaction fees | Phase 3+ (with transaction volume) | 0.5–1% fee on escrows using `automated_reasoning`, min $0.01 |
| **Marketplace** | End users, revenue-shared with creator | Phase 3+ (policy marketplace) | Per-use fee (fractions of a cent). Creator 70%, TTV 30% |

Start with creator-funded. Layer in platform-amortized for TTV's own pre-built policy templates. Marketplace activates when there's enough policy diversity to justify it.

The API supports all three via a `billing` field on policy creation:

```
POST /policies { ..., billing: "creator" | "platform" | "marketplace" }
```

### 3.2 Argus Codex (Adversarial Policy Refinement)

Formal policies are only as good as their specifications. A policy that checks word count and keyword presence but not coherence will accept Lorem Ipsum with the right keywords. Argus Codex catches these gaps before they become exploits.

**How it works:**

Two LLMs compete:

1. **Policy LLM** generates formal acceptance criteria from natural language intent.
2. **Adversary LLM** searches for outputs that satisfy the literal criteria while violating the stated intent.

Each exploit the adversary finds triggers a policy refinement. The cycle repeats until the adversary can't find any more exploits within the computational budget.

**Example:**

```
Intent: "Summarize this research paper in 200-500 words covering methodology, findings, and limitations"

Round 1 policy:
  word_count BETWEEN 200 AND 500
  contains_section("methodology")
  contains_section("findings")
  contains_section("limitations")

Adversary finds: "Copy-paste the paper's abstract + section headers. 
  Satisfies word count, contains all three section keywords."

Round 2 policy (refined):
  word_count BETWEEN 200 AND 500
  contains_section("methodology")
  contains_section("findings")
  contains_section("limitations")
  + no_substring_match(input, output, threshold=0.3)  // max 30% overlap with source
  + sentence_count >= 8                                // not just headers

Adversary finds: "Generate random sentences containing the keywords. 
  Passes overlap check because it's original, passes sentence count."

Round 3 policy (refined):
  ... + semantic_coherence_score >= 0.6               // sentences must relate to each other
  ... + topic_relevance(input_abstract, output) >= 0.5 // must actually be about the paper

After 1000 attempts, adversary finds no more exploits.
Final policy stored with coverage estimate.
```

**Important caveat from the Benno paper (§7.2):** Argus Codex provides engineering confidence, not mathematical certainty. You cannot prove a policy is complete — only that adversarial search with budget B found no exploits. This is analogous to fuzzing in software security: high confidence, not formal proof. For the 2-5% of truly adversarial edge cases, escrow collateral remains the backstop.

**When to use Argus Codex:**
- High-value escrows (>$100) — worth the compute cost of adversarial search
- New task types being added to the platform — refine once, reuse the policy
- After a dispute reveals a policy gap — adversarial search finds similar gaps

**When NOT to use it:**
- Micro-transactions where the adversarial search costs more than the transaction
- Pure deterministic tasks (hash match, computation) where the policy is trivially complete
- Time-sensitive transactions where async refinement adds unacceptable latency

**Tech:** Two LLM API calls per refinement round. Budget of 1,000 rounds ≈ 2,000 API calls ≈ ~$5-20 depending on model. Runs async via Cloudflare Queue. Results cached: once a task type's policy is refined, all future transactions of that type use the refined policy.

**Mechanical details:**

- **Adversary prompt:** Receives the original NL intent + the current `formal_spec` JSON. Prompt: "Generate a concrete output (valid JSON matching the deliverable schema) that satisfies every constraint in the formal_spec but clearly violates the stated intent. Explain the exploit."
- **Refinement prompt:** When the adversary finds an exploit, a third LLM call generates the patch: receives the current `formal_spec` + the exploit + the intent, outputs an updated `formal_spec` with new constraints that block the exploit. The patch must use constraint types from §3.1.2.
- **Stopping conditions:** (a) Budget exhausted (default 1,000 rounds), OR (b) 200 consecutive rounds with no exploit found (early stop). Whichever comes first.
- **Coverage estimate:** `rounds_with_no_exploit / total_rounds_after_last_exploit`. If the adversary found its last exploit at round 400 and rounds 401–1000 found nothing, coverage estimate = 600/600 = 1.0. This is a heuristic, not a proof — it measures adversary exhaustion, not true completeness.
- **Argus Codex prefers Tier 1 constraints.** When generating patches, the refinement prompt is instructed to use Tier 1 (deterministic) constraint types from §3.1.2 whenever possible. Tier 2 (semantic) constraints are a last resort — only introduced when the exploit cannot be blocked by any Tier 1 constraint. This keeps the verification path fast and dependency-free.
- **Output:** Refined `formal_spec` JSON, updated coverage map, list of exploits found (stored in `argus_exploits` JSONB), coverage estimate. Policy transitions to `approved` automatically if coverage estimate ≥ 0.9 and no Tier 2 constraints were introduced. Otherwise stays in `validated` for human review.

### 3.3 Verification Method Summary

| Method | How It Works | Dispute Rate | When to Use | Automation Level |
|---|---|---|---|---|
| `hash_match` | `SHA256(output) === expected` | 0% | Buyer knows exact expected output | Fully automated |
| `schema_validation` | Output matches JSON schema | ~0% | Structured data retrieval | Fully automated |
| `automated_reasoning` | Output satisfies formal policy | <5% (policy gaps) | Any task with specifiable criteria | Fully automated |
| `oracle_consensus` | N agents run same task, majority wins | ~0% | Reproducible tasks, unknown output | Fully automated, expensive |
| `buyer_confirm` | Buyer manually confirms | ~10-20% | Tasks with no formal spec | Manual |
| `zkml_proof` | Cryptographic proof of execution compliance | ~0% | Future: any task with formal policy | Fully automated |

**Verification method details (for methods not covered in §3.1):**

- **`hash_match`:** Buyer includes `expected_hash` (SHA-256 hex) in `task_spec` at proposal time. Both parties see it before funding. Gateway computes `SHA256(JSON.stringify(deliverable))` with keys sorted (RFC 8785 JCS) and compares. Match = pass, mismatch = fail. No policy needed. Use when the buyer knows the exact expected output (e.g., deterministic computation, file retrieval).

- **`schema_validation`:** Buyer includes `expected_schema` (JSON Schema draft-07 object) in `task_spec` at proposal time. Gateway validates the `deliverable` against the schema. Valid = pass, invalid = fail. No policy needed. This is simpler than `automated_reasoning` — use it when you only need structural validation (field types, required fields) without value constraints.

**The progression is clear:** move tasks UP this table. Every task that moves from `buyer_confirm` to `automated_reasoning` eliminates human judgment from the verification loop. Every task that eventually moves to `zkml_proof` eliminates even the possibility of a clever adversarial output that satisfies the policy but violates intent (because the proof covers the reasoning process, not just the output).

### 3.4 Dispute Resolution (for Remaining Edge Cases)

Despite formal verification and adversarial refinement, some disputes will occur: policy gaps Argus Codex missed, novel exploit patterns, ambiguous intent that no formal policy can fully capture.

**Disputes are the exception, not the standard path.** The protocol's entire design (formal policies, automated verification, Argus Codex refinement, oracle consensus) exists to prevent disputes from ever happening. When they do occur, there is exactly one round of resolution — no appeals, no escalation. This is by design: disputes are expensive, and the protocol incentivizes agents to avoid them by building good policies and delivering quality work.

**Mode 1: Arbitrate (default).** A third-party LLM reviews the evidence — task spec, policy, verification results, deliverable, and dispute reason — and issues a single binding ruling: `buyer_wins` or `seller_wins`. The losing party pays a 10% arbitration fee to the platform. One round only, no appeal.

| Ruling | Buyer gets | Seller gets | Platform gets |
|---|---|---|---|
| `buyer_wins` | Payment minus 10% fee | Nothing | 10% fee + seller collateral |
| `seller_wins` | Nothing | Payment minus 10% fee | 10% fee |

The arbitrating LLM is a different model from any model that may have generated or verified the deliverable. This is not a human arbitrator — it is automated, fast, and deterministic for a given evidence set. The 10% fee makes frivolous disputes economically irrational.

**Mode 2: Burn (opt-in).** Both deposits destroyed. Neither party benefits from disputing. Game-theoretically sound: buyers only dispute when work is truly unacceptable, sellers only deliver garbage if losing collateral is acceptable. Deadweight loss is the price of decentralization. Set `dispute_resolution: 'burn'` in escrow proposal to opt in.

**Staged execution (for irreversible actions).** Decompose irreversible tasks into verifiable stages. "Deploy to production" becomes "deploy to staging" (verified) → "run tests" (verified) → "promote to production" (buyer executes). Each stage has its own escrow and formal policy.

### 3.5 Oracle Consensus Verification

For tasks where automated reasoning cannot determine correctness — e.g., "is this summary accurate?", "does this design meet the brief?" — a pool of independent oracle agents votes pass/fail on the deliverable. This is the protocol's answer to subjective quality assessment without centralized authority.

#### 3.5.1 Oracle Pool

Agents opt in to the oracle pool via `POST /v2/oracles/join` with optional capability tags (e.g., `["code_review", "content_quality"]`). Oracles can withdraw via `POST /v2/oracles/withdraw`, which sets their status to `withdrawn`. The pool is self-selecting: any registered agent can join.

**Selection rules:**
- Random selection from active pool members
- Buyer and seller of the escrow are always excluded
- Minimum 5 eligible oracles required for dispatch
- If fewer than 5 eligible: fallback to `buyer_confirm` (graceful degradation)

#### 3.5.2 Dispatch Flow

1. Seller delivers with `verification_method: 'oracle_consensus'`
2. Escrow transitions to `delivered`, queue message of type `oracle_dispatch` is enqueued
3. Queue consumer selects 5 oracles from active pool (excluding buyer/seller)
4. Creates one `oracle_task` row and 5 `oracle_vote` assignment rows (status `pending`)
5. Oracles poll `GET /v2/oracles/tasks` to see their pending assignments
6. Each assignment includes the full deliverable, task spec, and policy context
7. Oracles submit `POST /v2/oracles/vote` with verdict (`pass` or `fail`) and rationale
8. Each vote submission triggers a consensus check — early termination when quorum (3) reached
9. On consensus: `pass` releases escrow, `fail` fails escrow
10. On timeout (30 min window): resolve with partial votes if quorum met, else fallback to `buyer_confirm`

#### 3.5.3 Consensus Logic

- **Pool size per task:** 5 oracles
- **Quorum:** 3 (simple majority)
- **Vote type:** Binary (pass/fail)
- With 5 binary votes, a majority always exists if all oracles vote (minimum 3-2 split)
- `no_consensus` only occurs when the voting window expires before quorum is reached
- Early termination: as soon as 3 votes agree, the task is decided without waiting for remaining votes
- Cron job sweeps expired oracle tasks, resolves with partial votes or falls back to `buyer_confirm`

#### 3.5.4 Payment

- **Platform-funded** — oracle fees come from the platform, not the escrow amount
- Default: $1.00 per oracle per task (configurable via `ORACLE_FEE_CENTS` env var)
- **All oracles who vote are paid**, regardless of whether they aligned with the majority
- Payment records are created on task finalization with status `pending`
- Actual disbursement (Stripe payouts or on-chain transfers) is a future enhancement

#### 3.5.5 Database Schema

Four new tables support oracle verification:

- **`oracle_pool`** — Agent opt-in registry. Tracks status (`active`/`withdrawn`), capability tags, and accuracy statistics (`tasks_completed`, `accuracy_score`).
- **`oracle_tasks`** — One row per verification round. Links to escrow, stores deliverable snapshot, quorum requirement, consensus result, and voting window expiry.
- **`oracle_votes`** — One row per oracle per task. Stores verdict, rationale, and timestamp. Status tracks `pending`/`submitted`/`expired`.
- **`oracle_payments`** — Audit trail for oracle compensation. Links to task and oracle, stores amount and payment status (`pending`/`paid`).

#### 3.5.6 Error Handling

| Scenario | Behavior |
|---|---|
| Fewer than 5 eligible oracles | Fallback to `buyer_confirm`, no oracle task created |
| Oracle is buyer or seller | Excluded at selection; belt-and-suspenders rejection at vote time |
| Vote submitted after task decided | `409 Conflict` |
| Vote submitted after window expired | `409 Conflict` |
| Escrow state changed externally | Oracle task marked `failed`, oracles still paid for submitted votes |
| All 5 vote, 3-2 split | Majority wins, early termination on 3rd agreeing vote |
| Timeout with 2 pass, 1 fail | Quorum not met (need 3), fallback to `buyer_confirm` |
| Timeout with 3 pass, 0 fail | Pass — quorum met even with missing votes |

#### 3.5.7 API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v2/oracles/join` | Required | Join oracle pool |
| POST | `/v2/oracles/withdraw` | Required | Leave oracle pool |
| GET | `/v2/oracles/status` | Required | Own pool statistics |
| GET | `/v2/oracles/tasks` | Required | Pending vote assignments |
| POST | `/v2/oracles/vote` | Required | Submit verdict on assignment |
| GET | `/v2/oracles/task/:id` | None | Public task status |

---

## 4. The Verification Gateway

This is the architectural component that makes pre-execution verification possible. The Benno paper's framework requires actions to be verified BEFORE they take effect. The Verification Gateway is that temporal buffer.

### 4.1 How It Works

The Cloudflare Worker acts as a proxy between the agent and external effects:

```
Agent B completes task
  → B submits deliverable to Verification Gateway (Worker)
  → Gateway runs verification method specified in escrow:
      - automated_reasoning: run formal policy check (<100ms)
      - schema_validation: validate against JSON schema (<10ms)
      - oracle_consensus: dispatch to oracle agents (async, seconds to minutes)
      - zkml_proof: verify cryptographic proof (<300ms, future)
      - buyer_confirm: notify buyer, wait for confirmation (manual)
  → If PASS: Gateway triggers escrow release on-chain
  → If FAIL: Gateway triggers escrow refund, logs violation
  → Action effects (payment release) only occur AFTER verification
```

**The critical property:** No funds move until verification completes. This is the temporal inversion that Benno's paper identifies as essential — traditional monitoring observes outcomes after irreversible damage; this framework proves compliance before effects materialize.

#### 4.1.1 Deliverable Format

Deliverables are JSON objects. The seller submits them via `POST /escrow/:id/deliver`:

```json
{
  "deliverable": { ... }
}
```

The `deliverable` field is the root (`$`) that constraints target. Its internal structure is task-type-specific and must match what the policy's constraints reference. For example, a web search policy targeting `$.results[*].url` expects `{ "results": [{ "url": "...", ... }] }`.

**Constraints:**
- Must be valid JSON
- Max size: 1MB (covers text-based deliverables; binary artifacts are out of scope — use a URL reference)
- Must parse within the Worker's memory budget

**Non-JSON deliverables** (images, files, executables) are represented as JSON with URL references: `{ "artifact_url": "https://...", "artifact_hash": "sha256:..." }`. The policy can verify the hash and URL format via Tier 1 constraints, but cannot inspect the artifact's content. Content inspection requires `buyer_confirm` or an oracle.

#### 4.1.2 Verification Failure and Error Handling

The Gateway can produce three outcomes, not two:

| Outcome | Meaning | Escrow Effect |
|---|---|---|
| `pass` | All constraints satisfied | Release funds to seller |
| `fail` | One or more constraints not satisfied | Refund buyer, burn seller collateral |
| `error` | Verification could not complete | Fall back (see below) |

**`error` cases and fallback behavior:**
- **Malformed deliverable** (not valid JSON, exceeds size limit): Treat as `fail`. Seller submitted garbage.
- **Constraint solver bug** (solver crashes on a valid deliverable): Log the error, **do not auto-fail**. Escrow stays in `active` state. Seller can re-deliver. If the bug persists after 3 retries, fall back to `buyer_confirm` and notify both parties. This prevents the Gateway from incorrectly punishing sellers due to its own bugs.
- **Tier 2 service unavailable** (Workers AI down): Skip Tier 2 constraints. If all Tier 1 constraints pass, result is `pass_partial` — escrow releases but the verification record is flagged. If Tier 1 constraints fail, result is `fail` regardless. Tier 2 being down never blocks a valid Tier 1 result.
- **Timeout** (verification exceeds 25s wall clock): Treat as `error`, same as solver bug. Re-delivery allowed.

**Principle: the Gateway should not be more dangerous than no Gateway.** If the verification system itself fails, fall back gracefully rather than auto-punishing either party. The escrow timeout is the ultimate backstop.

### 4.2 What the Gateway Stores

The Gateway logs every verification result:

```json
{
  "escrow_id": "uuid",
  "verification_method": "automated_reasoning",
  "policy_id": "uuid",
  "result": "pass",
  "constraints_checked": 7,
  "constraints_passed": 7,
  "verification_time_ms": 47,
  "proof": null,
  "timestamp": "2026-02-25T12:00:00Z",
  "gateway_signature": "hex..."
}
```

The Gateway signs every verification result. This creates an auditable trail: anyone can verify that the Gateway actually ran the check. When zkML is available, the Gateway's own verification logic can be wrapped in a proof, eliminating trust in the Gateway itself.

**Gateway signature scheme:**
1. Canonical string: `${escrow_id}\n${result}\n${constraints_checked}\n${constraints_passed}\n${verified_at_iso8601}`
2. Sign with the Gateway's secp256k1 private key (ECDSA, deterministic k per RFC 6979)
3. Hex-encode the signature → stored in `gateway_signature`
4. Anyone can verify by recovering the public key from the signature and comparing it to the `authorizedGateway` address on the EscrowFactory contract (or the Gateway's known pubkey for Stripe-mode escrows)

---

## 5. Tech Stack

### 5.1 Stack Summary

| Layer | Technology | Purpose | Buildable Now? |
|---|---|---|---|
| **API / Gateway** | Cloudflare Workers + Hono | Request routing, verification gateway, action proxy | Yes |
| **Escrow** | Base L2 smart contracts (USDC) | Trustless fund locking, automated release | Yes |
| **Policy Engine** | AR constraint solver (in Worker) | Deterministic Tier 1 constraint verification (<100ms) | Yes |
| **Policy Semantics** | Cloudflare Workers AI | Tier 2 semantic constraints (similarity, relevance, coherence) | Yes |
| **Policy Refinement** | Argus Codex (LLM pair, async via Queue) | Adversarial criteria tightening with coverage estimation | Yes |
| **Policy Translation** | Dual-provider LLM (translate + cross-validate) | NL → formal_spec JSON with coverage map | Yes |
| **Database** | Supabase (PostgreSQL) | Agent registry, escrow metadata, policies, disputes | Yes |
| **Queue** | Cloudflare Queues | Async Argus Codex, oracle dispatch, timeout sweep | Yes |
| **Identity** | secp256k1 keypairs (client-generated) | One key = identity + signing | Yes |
| **Attestation** | Nostr relays | Peer-to-peer observation sharing | Yes |
| **Proof Verification** | zkML verifier | Constant-time cryptographic proof checks | Future |

### 5.2 What's Removed from v1 and Why

| v1 Component | Status | Reason |
|---|---|---|
| Cloudflare KV | Removed | No scores to cache. Policies are stored in Supabase. |
| Cloudflare R2 | Removed | No score_events archive. Escrow state is on-chain. Attestations live on Nostr. |
| Stripe receipt verification | Removed | Escrow is the payment mechanism. No need to verify external payments. |
| Score engine (4 dimensions) | Removed | No centralized scoring. Each agent computes trust locally. |
| Chain anchoring cron | Removed | Escrow transactions ARE on-chain. No separate integrity layer. |
| Fraud detection Edge Functions | Removed | No reviews to fake. Escrow game theory + formal verification handle incentives. |
| Operator layer | Simplified | Operators are just agents that spawn other agents. New agents post collateral like everyone else. |
| Challenge system | Replaced | Formal policy verification replaces behavioral challenges. Agents prove compliance through formal methods, not challenge-response tests. |

### 5.3 Why These Choices

**Cloudflare Workers + Hono (API / Verification Gateway):** The Worker is now two things: an API router AND a verification proxy. Every write request passes through the Gateway, which runs the AR constraint solver before triggering on-chain escrow operations. Workers have native crypto APIs, run at the edge globally, and have a 30-second wall-clock limit — more than enough for AR verification (<100ms) but not enough for zkML proof generation (seconds to minutes). Proof generation happens on the agent's side; the Worker only verifies.

**Base L2 smart contracts (Escrow):** On-chain escrow is the trustless foundation. Neither party nor TTV can steal funds. USDC denomination avoids ETH price volatility during escrow. Gas costs: ~$0.01 per transaction on Base L2.

**For agents that can't or won't use crypto:** Stripe Connect escrow (TTV holds funds) as a "training wheels" mode. The protocol logic is identical — only the settlement layer changes. See §9.2.

**Supabase (PostgreSQL):** Stores agent registry, escrow metadata (task specs are too large for on-chain), formal policies, Argus Codex refinement results, and dispute records. NOT used for scores (don't exist), score events (don't exist), or transaction history (on-chain).

**Cloudflare Queues (Async):** Argus Codex refinement is compute-intensive (minutes, not milliseconds). Oracle consensus requires dispatching tasks to multiple agents and collecting results. Escrow timeout sweeps run on a schedule. All of these are async jobs that don't block the request path.

**secp256k1 keypairs (Identity):** Generated client-side. The registry never sees private keys. This is a hard requirement — the v1 spec generated keys server-side, which means the server could impersonate any agent. Changed.

**Nostr relays (Attestation):** Agents already have Nostr-compatible keys. Relays are free, decentralized, and operational. No infrastructure to build or maintain for the attestation layer.

---

## 6. Data Architecture

### 6.1 Transaction Flow (Common Case with AR Verification)

```
Agent A wants to buy a web search from Agent B for $0.50.

1. DISCOVERY (out of protocol scope)
   A knows B's public key and endpoint.

2. VERIFY IDENTITY (< 1 second)
   A → B: { challenge: random_nonce }
   B → A: { signature: sign(nonce, B_privkey) }
   A verifies. ✓

3. NEGOTIATE + POLICY SELECTION (< 1 second)
   A → B: { task: "web_search", query: "AI agent frameworks 2026" }
   B → A: { price_cents: 50, collateral_ratio: 0.5, timeout_seconds: 300 }
   A selects policy_id for "web_search" task type (pre-refined via Argus Codex):
     ∀ result: result.date ≥ now() - 30d AND result.url IS valid
     |results| ≥ 5
     ∃ result: topic_relevant(result, query) ≥ 0.5

4. ESCROW (< 5 seconds on Base L2)
   A deposits: 50 cents (payment)
   B deposits: 25 cents (collateral)
   Escrow metadata: { task_spec, policy_id, verification_method: "automated_reasoning" }
   Contract state: FUNDED

5. EXECUTE (variable — seconds to minutes)
   B performs web search.
   B submits deliverable to Verification Gateway:
     POST /v2/escrow/{id}/deliver { "deliverable": { "results": [...] } }

6. VERIFY (< 100ms in Gateway)
   Gateway loads formal policy from policy_id.
   Gateway runs AR constraint solver against deliverable.
   All constraints pass. ✓
   Gateway signs verification result.
   Gateway triggers escrow release on-chain.

7. RELEASE (< 5 seconds on Base L2)
   50 cents → B. 25 cents collateral → B.
   Contract state: COMPLETED

8. OBSERVE (local, instant)
   A records: { counterparty: B, outcome: success, verification: automated_reasoning, time: 3400ms }
   B records: { counterparty: A, outcome: success, payment: 50_cents }

No buyer confirmation needed. No dispute. No human.
Total time: ~15 seconds, dominated by on-chain settlement.
```

### 6.2 Flow with Argus Codex (New Task Type)

```
Developer wants to create a "research_summary" task type.

1. TRANSLATE (one-time, ~5 seconds)
   Developer provides intent:
     "Summarize a research paper in 200-500 words covering methodology, findings, limitations.
      Summary must be original (not copy-pasted), coherent, and relevant to the source paper."
   
   LLM translates to formal policy (first draft):
     word_count BETWEEN 200 AND 500
     contains_section("methodology")
     contains_section("findings")  
     contains_section("limitations")

2. REFINE (async, ~2-5 minutes)
   Argus Codex runs adversarial search with budget = 1000:
   
   Adversary attempt 47: "Copy abstract + add section headers"
     → Exploit found. Policy refined: + no_substring_match(source, output, 0.3)
   
   Adversary attempt 203: "Generate random sentences with section keywords"
     → Exploit found. Policy refined: + semantic_coherence >= 0.6
   
   Adversary attempt 589: "Summarize a DIFFERENT paper"
     → Exploit found. Policy refined: + topic_relevance(source_abstract, output) >= 0.5
   
   Adversary attempts 590-1000: no new exploits found.
   
   Final policy stored: policy_id = "research_summary_v3"
   Coverage estimate: 94.1% of action space explored.

3. REUSE
   Every future "research_summary" escrow references policy_id = "research_summary_v3".
   No per-transaction Argus Codex cost. Refine once, verify many.
```

### 6.3 Schema

```sql
-- Agent registry
agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key      TEXT UNIQUE NOT NULL,
  endpoint        TEXT,
  name            TEXT,
  capabilities    JSONB DEFAULT '[]',
  metadata        JSONB DEFAULT '{}',
  parent_id       UUID REFERENCES agents(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  last_seen_at    TIMESTAMPTZ DEFAULT now()
)

-- Formal acceptance policies (reusable across transactions)
policies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  intent          TEXT NOT NULL,              -- original natural language intent
  formal_spec     JSONB NOT NULL,             -- constraint array (see §3.1.1 format)
  version         INTEGER DEFAULT 1,
  status          TEXT DEFAULT 'draft',       -- draft | validated | approved | active | deprecated
  billing         TEXT DEFAULT 'creator',     -- creator | platform | marketplace
  tier2_used      BOOLEAN DEFAULT FALSE,      -- true if any Tier 2 (semantic) constraints
  translation_model TEXT,                     -- which LLM translated (e.g., 'claude-sonnet-4-6')
  cross_validator   TEXT,                     -- which LLM cross-validated (e.g., 'o3')
  cross_validation  JSONB,                    -- cross-validator report (contradictions, omissions)
  argus_budget    INTEGER,                    -- adversarial search budget used
  argus_coverage  FLOAT,                      -- estimated action space coverage (0-1)
  argus_exploits  JSONB,                      -- exploits found during refinement
  parent_version  UUID REFERENCES policies(id), -- previous version (if refined)
  created_by      UUID REFERENCES agents(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  activated_at    TIMESTAMPTZ,
  deprecated_at   TIMESTAMPTZ
)

-- Coverage map: links NL clauses to constraints (see §3.1.3)
policy_coverage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id       UUID REFERENCES policies(id) ON DELETE CASCADE,
  clause_index    INTEGER NOT NULL,
  clause_text     TEXT NOT NULL,              -- original NL clause
  constraint_ids  TEXT[] NOT NULL DEFAULT '{}', -- which constraint IDs cover this clause
  status          TEXT NOT NULL,              -- 'covered' | 'partial' | 'uncovered'
  note            TEXT,                       -- explanation for uncovered/partial clauses
  created_at      TIMESTAMPTZ DEFAULT now()
)

-- Escrow records (on-chain state is canonical; this is metadata)
escrows (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_address    TEXT,                        -- Base L2 address (null for Stripe escrow)
  stripe_escrow_id    TEXT,                        -- Stripe Connect ID (null for on-chain)
  buyer_id            UUID REFERENCES agents(id),
  seller_id           UUID REFERENCES agents(id),
  amount_cents        INTEGER NOT NULL,
  seller_collateral   INTEGER NOT NULL,
  task_hash           TEXT NOT NULL,               -- SHA-256 hex of JSON.stringify(task_spec) with keys sorted (RFC 8785 JCS)
  task_spec           JSONB NOT NULL,
  policy_id           UUID REFERENCES policies(id), -- formal acceptance policy
  verification_method TEXT DEFAULT 'buyer_confirm',
  dispute_resolution  TEXT DEFAULT 'arbitrate',
  status              TEXT DEFAULT 'proposed',
  proof               TEXT,                         -- zkML proof hash (future)
  created_at          TIMESTAMPTZ DEFAULT now(),
  funded_at           TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL
)

-- Verification results (logged by Gateway)
verifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id           UUID REFERENCES escrows(id),
  method              TEXT NOT NULL,
  policy_id           UUID REFERENCES policies(id),
  result              TEXT NOT NULL,                 -- 'pass' | 'fail' | 'pass_partial' | 'error' (see §4.1.2)
  constraints_total   INTEGER,
  constraints_passed  INTEGER,
  failure_details     JSONB,                         -- which constraints failed and why
  proof_hash          TEXT,                          -- zkML proof reference (future)
  gateway_signature   TEXT NOT NULL,                 -- Gateway's signature over this result
  verified_at         TIMESTAMPTZ DEFAULT now()
)

-- Disputes (only for edge cases that verification can't resolve)
disputes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id       UUID REFERENCES escrows(id),
  initiator_id    UUID REFERENCES agents(id),
  reason          TEXT,
  evidence_hash   TEXT,
  arbitrator_id   UUID REFERENCES agents(id),
  ruling          TEXT,
  status          TEXT DEFAULT 'open',
  created_at      TIMESTAMPTZ DEFAULT now(),
  resolved_at     TIMESTAMPTZ
)

-- Attestations (optional — agents can also publish directly to Nostr)
attestations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id       UUID REFERENCES agents(id),
  subject_id      UUID REFERENCES agents(id),
  escrow_id       UUID REFERENCES escrows(id),
  outcome         TEXT NOT NULL,
  verification_method TEXT,
  signature       TEXT NOT NULL,
  nostr_event_id  TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
)
```

### 6.4 Indexes

```sql
CREATE UNIQUE INDEX idx_agents_pubkey ON agents(public_key);
CREATE INDEX idx_agents_capabilities ON agents USING GIN(capabilities);
CREATE INDEX idx_escrows_buyer ON escrows(buyer_id, status);
CREATE INDEX idx_escrows_seller ON escrows(seller_id, status);
CREATE INDEX idx_escrows_expires ON escrows(expires_at) WHERE status IN ('proposed','funded','active');
CREATE INDEX idx_policies_name ON policies(name, version DESC);
CREATE INDEX idx_policies_status ON policies(status) WHERE status = 'active';
CREATE INDEX idx_policy_coverage_policy ON policy_coverage(policy_id);
CREATE INDEX idx_policy_coverage_uncovered ON policy_coverage(policy_id) WHERE status = 'uncovered';
CREATE INDEX idx_verifications_escrow ON verifications(escrow_id);
CREATE INDEX idx_attestations_subject ON attestations(subject_id, created_at DESC);
```

---

## 7. Peer-to-Peer Attestation Layer

Optional. Agents can transact safely using escrow + formal verification alone.

### 7.1 How It Works

After a transaction, an agent MAY sign and publish an attestation to Nostr relays:

```json
{
  "type": "ttv_attestation",
  "version": 1,
  "author": "npub1...",
  "subject": "npub2...",
  "escrow_tx": "0xabc...",
  "outcome": "success",
  "verification_method": "automated_reasoning",
  "task_category": "web-search",
  "delivery_time_ms": 3400,
  "timestamp": 1708761600,
  "sig": "hex..."
}
```

### 7.2 Local Trust Computation

There is no canonical trust score. Each agent computes its own assessment:

```
Agent A evaluates Agent B:
  1. Local observations: 12 successful, 0 disputes → high direct trust
  2. Nostr attestations: 47 total, 44 success, 2 partial, 1 dispute
  3. On-chain escrow history: 200 completed, 3 disputes, 98.5% completion
  4. A decides: require 30% collateral (reduced from default 50%)
```

The SDK provides a `suggestCollateral()` helper — convenience function, not authoritative:

```typescript
const suggestion = await sdk.suggestCollateral(counterpartyPubkey, 500);
// { suggestedRatio: 0.3, confidence: 'high', dataPoints: 59 }
```

---

## 8. Smart Contract Design

### 8.1 Escrow Contract (Base L2)

Factory pattern: one factory deploys minimal escrow instances.

```
EscrowFactory.create(buyer, seller, amount, collateral, timeout, verificationMethod, policyHash)
  → deploys EscrowInstance

EscrowInstance:
  fund()                          — both parties deposit
  submitDeliverable(resultHash)   — seller marks complete
  confirmDelivery()               — buyer confirms (manual method)
  gatewayRelease(gatewaySig)      — Gateway confirms (AR/oracle/zkml methods)
  dispute(reasonHash)             — either party disputes
  timeout()                       — release/refund on expiry
  arbitrate(ruling)               — arbitrator ruling (Category 3 only)
```

**Key addition: `gatewayRelease()`.** When the verification method is `automated_reasoning`, `oracle_consensus`, or `zkml_proof`, the Gateway (not the buyer) triggers release by submitting its signed verification result. This removes the buyer from the release path for automated verification methods.

#### 8.1.1 Gateway Key Management

**Simple model (ship this):** One secp256k1 keypair per Gateway instance. Private key stored in Cloudflare Workers secrets (`GATEWAY_PRIVATE_KEY`). The EscrowFactory contract stores an `authorizedGateway` address set at deployment.

```
EscrowFactory:
  authorizedGateway  address     — set at deployment
  owner              address     — can rotate authorizedGateway

  rotateGateway(newAddress)      — owner-only, emits GatewayRotated event
```

`gatewayRelease()` verifies `ecrecover(sig) == authorizedGateway`. If the key is compromised, the owner calls `rotateGateway()`. Pending escrows using the old key can still release (the signature was valid when created) but no new releases are accepted from the old key.

**Why single key is fine for now:** The Gateway is already a centralization point (§12.3 #5). Adding multi-sig or multi-Gateway before there's transaction volume is premature complexity. The mitigation stack is: (a) key in Workers secrets (encrypted at rest, never in code), (b) owner can rotate, (c) all verification results are signed and logged (auditable), (d) zkML replaces Gateway trust long-term. Multi-Gateway is a Phase 6+ concern if/when transaction volume justifies it.

**Gas costs:** ~$0.01 per transaction on Base L2. For micro-transactions (<$1), use payment channels (batch settlement) or Stripe escrow.

### 8.2 Stripe Escrow (Training Wheels Mode)

Identical protocol logic, different settlement layer:

```
- TTV operates a Stripe Connect account
- Buyer deposits via Stripe → funds held in TTV's Connect account
- On release: Stripe transfer to seller's connected account
- On burn: funds transferred to TTV (protocol revenue)
```

This is NOT trustless — agents trust TTV with funds. But it eliminates the crypto on-ramp friction and works for developers who use Stripe today. The protocol API is identical; only the settlement method changes. Agents can migrate from Stripe escrow to on-chain escrow per-transaction as they become comfortable with crypto.

#### 8.2.1 Stripe Connect Identity Model

Agents establish Stripe identity before transacting:

- **Buyers** create a Stripe Customer (`POST /agents/:pubkey/stripe/customer`), then attach a PaymentMethod (`POST /agents/:pubkey/stripe/payment-method`).
- **Sellers** create a Stripe Express Connected Account (`POST /agents/:pubkey/stripe/connect`), completing Stripe's hosted onboarding flow.
- **Status** can be checked via `GET /agents/:pubkey/stripe/status`.

Agent table fields: `stripe_customer_id`, `stripe_connected_account_id`, `stripe_onboarding_complete`, `stripe_default_payment_method`.

In production mode, escrow acceptance validates that the buyer has a Customer + PaymentMethod and the seller has a completed Connect account. In sandbox mode, these validations are skipped.

#### 8.2.2 Dual Payment Intent Pattern

Each Stripe-mode escrow creates two PaymentIntents for game-theoretic parity with on-chain escrow:

| PI | Purpose | Amount |
|---|---|---|
| `stripe_buyer_pi_id` | Buyer's payment for the task | `amount_cents` |
| `stripe_seller_collateral_pi_id` | Seller's collateral deposit | `seller_collateral` |

Both PIs are captured atomically on escrow acceptance.

#### 8.2.3 Resolution Outcomes

| Outcome | Buyer PI | Seller Collateral PI |
|---|---|---|
| **Released** (success) | Transfer to seller's Connected Account | Refund to seller |
| **Failed** (verification failure) | Refund to buyer | Kept by platform |
| **Burned** (dispute timeout) | Kept by platform | Kept by platform |

This mirrors the on-chain game theory: sellers risk collateral, incentivizing honest delivery.

---

## 9. API Design

### 9.1 Base URL
`https://api.trustthenverify.com/v2`

### 9.2 Authentication
- **Reads:** No auth (agent lookup, policy browsing, attestation queries)
- **Registration (`POST /agents`):** Self-authenticated. The request body includes `public_key`. The server verifies that the request signature (see below) is valid for that pubkey. No prior registration required — the signature itself proves key ownership. This is the only write endpoint that does not require the pubkey to already exist in the `agents` table.
- **All other writes:** Signed request headers (pubkey must exist in `agents` table):

```
X-Agent-Pubkey: <hex-encoded secp256k1 public key>
X-Agent-Timestamp: <unix epoch seconds>
X-Agent-Signature: <hex-encoded secp256k1 signature>
```

**Signature scheme:**
1. Canonical string: `${timestamp}\n${METHOD}\n${path}\n${SHA256(body_bytes)}` (empty string body → SHA256 of empty string)
2. Sign canonical string with secp256k1 private key (ECDSA, deterministic k per RFC 6979)
3. Hex-encode the signature
4. Server rejects if `|now() - timestamp| > 30 seconds` (replay protection)
5. Server verifies signature against the pubkey in `X-Agent-Pubkey`, then confirms that pubkey exists in the `agents` table

### 9.3 Endpoints

```
# Identity
POST   /agents                        — register (pubkey + endpoint + capabilities)
GET    /agents/:pubkey                 — lookup
GET    /agents/search                  — search by capabilities
POST   /agents/:pubkey/verify          — keypair verification challenge
POST   /agents/:pubkey/spawn           — spawn child agent (see below)

# Stripe Onboarding (§8.2.1)
POST   /agents/:pubkey/stripe/customer        — create Stripe Customer (buyer)
POST   /agents/:pubkey/stripe/connect         — create Express Connected Account (seller)
POST   /agents/:pubkey/stripe/payment-method  — attach PaymentMethod to Customer
GET    /agents/:pubkey/stripe/status           — check onboarding completion

# Policies
POST   /policies                       — create policy (NL intent → formal_spec via translation pipeline)
GET    /policies/:id                   — get policy with formal spec + coverage map
POST   /policies/:id/revise             — submit revised NL intent; creates a NEW policy row (new UUID) linked via `parent_version`, re-runs translation pipeline, returns the new policy
POST   /policies/:id/activate          — transition approved → active (deprecated previous version)
POST   /policies/:id/refine            — trigger Argus Codex adversarial refinement (async)
GET    /policies/:id/refine/status     — check refinement progress
GET    /policies/:id/coverage          — get coverage map (clause → constraint mapping)
GET    /policies/templates             — browse pre-refined policy templates

# Escrow
POST   /escrow/propose                 — propose escrow terms + policy_id
POST   /escrow/:id/accept              — accept terms, both deposit
GET    /escrow/:id                     — status
POST   /escrow/:id/deliver             — submit deliverable (triggers verification)
POST   /escrow/:id/confirm             — buyer manual confirm (buyer_confirm method only)
POST   /escrow/:id/dispute             — initiate dispute

# Verification (internal — triggered by /deliver, exposed for transparency)
GET    /verify/:escrow_id              — verification result for an escrow

# Attestations
POST   /attestations                   — publish signed attestation (relayed to Nostr)
GET    /attestations/:pubkey           — query attestations about an agent

# Disputes
POST   /disputes                       — file for arbitration
GET    /disputes/:id                   — status
POST   /disputes/:id/ruling            — arbitrator submits ruling
```

**Spawn mechanics (`POST /agents/:pubkey/spawn`):**
- Only the agent identified by `:pubkey` can call this (enforced by signature auth). You spawn children of yourself, not of others.
- Request body: `{ public_key, endpoint?, name?, capabilities? }`. The child agent's keypair is generated client-side (same as registration). The child is a full agent with its own keypair.
- Server creates a new `agents` row with `parent_id` set to the spawner's agent ID. The child inherits nothing — capabilities, endpoint, and metadata are set explicitly in the request or left empty.
- The child is independently authenticated from this point. The parent has no special privileges over the child (no kill switch, no impersonation). The `parent_id` is metadata only — useful for operators tracking which agents they created.

**Search query format (`GET /agents/search`):**
- Query parameters: `?capabilities=web-search,summarization&match=any`
- `capabilities`: comma-separated list of capability strings.
- `match`: `any` (default) returns agents with at least one matching capability. `all` returns agents with every listed capability.
- Results paginated via `?cursor=` token from `meta.cursor` in the response.

~25 endpoints total. The Policies section has 8 endpoints to support coverage maps, activation, and iterative refinement.

**Policy creation is iterative but stateless.** The API is one-shot per call — no server-side sessions. The iteration loop (create → read coverage → revise NL → re-create) happens client-side in the SDK. `POST /policies/:id/revise` creates a new policy row (new UUID) from updated NL intent, linked to the original via `parent_version`. The server re-runs the translation pipeline and returns the new draft. The SDK's `revisePolicy()` helper drives this loop. No server-side conversation state, no WebSocket, no long-lived connections.

### 9.4 Response Envelope

All responses use a consistent JSON envelope:

**Success (2xx):**
```json
{
  "data": { ... },
  "meta": { "request_id": "uuid" }
}
```

**Error (4xx/5xx):**
```json
{
  "error": {
    "code": "SIGNATURE_INVALID",
    "message": "Human-readable description"
  },
  "meta": { "request_id": "uuid" }
}
```

**Rules:**
- `data` is always the resource or resource array — never a raw value.
- `meta.request_id` is a UUID generated per request (for support/debugging).
- List endpoints add `meta.count` (total) and `meta.cursor` (pagination token) when applicable.
- Error responses never include `data`. Success responses never include `error`.
- **Field casing:** All JSON field names in both requests and responses use **camelCase** (e.g., `publicKey`, `amountCents`, `taskSpec`). The API layer handles mapping to/from the database's `snake_case` column names internally. This applies to resource fields inside `data`, not to envelope keys (`data`, `meta`, `error`) which are already lowercase single words.

### 9.5 Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `INVALID_PARAMS` | Missing or malformed parameters |
| 401 | `SIGNATURE_INVALID` | Request signature doesn't match pubkey |
| 404 | `NOT_FOUND` | Agent, escrow, or policy not found |
| 409 | `ALREADY_FUNDED` | Escrow already funded |
| 409 | `ALREADY_COMPLETED` | Escrow already released |
| 422 | `VERIFICATION_FAILED` | Deliverable failed acceptance criteria |
| 422 | `POLICY_INVALID` | Formal spec has syntax/logic errors |
| 422 | `INSUFFICIENT_COLLATERAL` | Deposit doesn't match terms |
| 408 | `ESCROW_EXPIRED` | Timeout reached |
| 429 | `RATE_LIMITED` | Too many requests |

### 9.6 Sandbox Mode

The sandbox environment provides a risk-free path for developers to integrate the protocol without managing cryptographic keys or depositing real funds.

**Sandbox API:** `https://sandbox.trustthenverify.com/v2`

**Key differences from production:**

| Property | Sandbox | Production |
|---|---|---|
| **Authentication** | API key header (`X-Sandbox-Key: test_xxx`) | secp256k1 signature (§9.2) |
| **Funds** | Pre-funded test wallets (fake USDC, no real money) | Real USDC or Stripe |
| **Data retention** | Ephemeral — wiped weekly | Persistent |
| **Policy templates** | All templates available | All templates available |
| **Keypair management** | Auto-generated if omitted | Required (client-side) |
| **Rate limits** | Relaxed (100 req/min) | Standard (§9.5) |

**Sandbox authentication:**
- Obtain a sandbox API key from the developer dashboard (no payment method required)
- Include the key in all requests: `X-Sandbox-Key: test_xxx`
- ECDSA signing is NOT required in sandbox — the API key replaces `X-Agent-Signature` / `X-Agent-Timestamp`
- The SDK still sends `X-Agent-Pubkey` alongside `X-Sandbox-Key` so the server can identify the calling agent
- Agent registration (`POST /agents`) uses `publicKey` from the request body instead

**What works identically in sandbox:**
- Full escrow lifecycle (propose → accept → fund → deliver → verify → release)
- Policy creation, coverage maps, Argus Codex refinement
- Automated reasoning verification
- Attestation publishing (to sandbox-only Nostr relays)
- All SDK methods and MCP tools

**What does NOT work in sandbox:**
- On-chain escrow (Base L2 contracts are production-only)
- Real Stripe charges
- Cross-environment references (sandbox agent IDs don't exist in production)

**SDK integration:**
```typescript
const ttv = new TrustProtocol({ sandbox: true })
// or explicitly:
const ttv = new TrustProtocol({ apiUrl: 'https://sandbox.trustthenverify.com/v2' })
```

When `sandbox: true`, the SDK skips ECDSA signing and sends `X-Sandbox-Key` + `X-Agent-Pubkey` headers instead of the full signature triplet. The developer sets the key via the `TRUSTTHENVERIFY_SANDBOX_KEY` environment variable or passes it directly:

```typescript
const ttv = new TrustProtocol({ sandbox: true, sandboxKey: 'test_xxx' })
```

**Production requires full signature auth.** API keys are never accepted on the production endpoint. This ensures sandbox convenience doesn't weaken production security.

---

## 10. SDK Design

### 10.1 Zero-Config Reads

```typescript
import { lookupAgent, queryAttestations, getPolicy } from '@trustthenverify/sdk';

const agent = await lookupAgent('npub1...');
const attestations = await queryAttestations('npub1...', { limit: 50 });
const policy = await getPolicy('research_summary_v3');
```

### 10.2 Agent Registration

```typescript
import { generateKeypair, createAgent } from '@trustthenverify/sdk';

// Client-side keypair generation. Server NEVER sees private key.
const { publicKey, privateKey } = generateKeypair();

const agent = await createAgent({
  publicKey,
  privateKey,    // signs the registration request (self-authenticated, §9.2)
  endpoint: 'https://myagent.com/api',
  capabilities: ['web-search', 'summarization'],
});
```

### 10.3 Policy Creation + Refinement

```typescript
import { TrustProtocol } from '@trustthenverify/sdk';
const protocol = new TrustProtocol({ privateKey, publicKey });

// Create policy from natural language (dual-provider translation pipeline)
const policy = await protocol.createPolicy({
  name: 'web_search_v1',
  intent: 'Return 5+ relevant search results from the last 30 days',
});
// Returns: { policyId, formalSpec, coverageMap, status: 'draft', version: 1 }

// Check coverage — are all NL clauses covered by constraints?
const coverage = await protocol.getCoverage(policy.policyId);
// Returns: { clauses: [{ text, constraintIds, status }], uncoveredCount: 1 }

// If gaps exist, revise the NL intent and re-translate
if (coverage.uncoveredCount > 0) {
  const revised = await protocol.revisePolicy(policy.policyId, {
    intent: 'Return 5+ relevant search results from the last 30 days. '
      + 'Each result must have a title, URL, date, and snippet.',
  });
  // Creates NEW policy row (new UUID) linked via parent_version, re-runs translation
  // revised.id !== policy.policyId — it's a new version
}

// Activate when satisfied with coverage
await protocol.activatePolicy(policy.policyId);
// Status: approved → active

// Optionally refine with Argus Codex (async)
const refinement = await protocol.refinePolicy(policy.policyId, { budget: 1000 });
// Returns immediately: { refinementId, status: 'running' }

// Poll for completion (uses policy ID — one active refinement per policy)
const result = await protocol.refinementStatus(policy.policyId);
// When done: { status: 'complete', exploitsFound: 3, coverageEstimate: 0.94,
//              refinedPolicyId: 'web_search_v2' }
```

#### Pre-Built Policy Templates

The platform ships with pre-refined policy templates for common task types. These are available via `GET /policies/templates` and can be referenced by name in escrow proposals — no policy creation required.

| Template Name | Task Type | Key Constraints | Tier 2? |
|---|---|---|---|
| `web_search_v1` | Search results | Result count, valid URLs, date recency, snippet non-empty | No |
| `summarization_v1` | Text summarization | Word count range, sentence count, overlap ratio (<30% with source), coherence | Yes (coherence) |
| `data_retrieval_v1` | Structured data | JSON schema validation, required fields, type checks, non-null values | No |
| `code_execution_v1` | Code output | Output format (stdout/stderr/exit_code), no error strings, deterministic re-run match | No |
| `translation_v1` | Language translation | Source/target language detection, length ratio (0.7-1.5×), completeness (no truncation) | Yes (completeness) |

**Usage:**
```typescript
// Use a template directly — no policy creation needed
const escrow = await protocol.proposeEscrow({
  seller: counterpartyPubkey,
  amountCents: 100,
  collateralRatio: 0.5,
  taskSpec: { type: 'web-search', query: 'AI frameworks 2026' },
  policyId: 'web_search_v1',  // references pre-built template
  verificationMethod: 'automated_reasoning',
});
```

Templates are pre-refined via Argus Codex with a budget of 1,000 rounds. Developers can fork a template (`POST /policies/:id/revise`) to customize constraints for their specific use case.

### 10.4 Transaction (Full Flow)

```typescript
// 1. Verify counterparty
const verified = await protocol.verify(counterpartyPubkey);

// 2. Suggest collateral
const suggestion = await protocol.suggestCollateral(counterpartyPubkey, 500);

// 3. Propose escrow with formal policy
const escrow = await protocol.proposeEscrow({
  seller: counterpartyPubkey,
  amountCents: 500,
  collateralRatio: suggestion.suggestedRatio,
  taskSpec: { type: 'web-search', query: 'AI frameworks 2026' },
  policyId: 'web_search_v2',                    // pre-refined policy
  verificationMethod: 'automated_reasoning',      // Gateway verifies, not buyer
  timeoutSeconds: 300,
});

// 4. Wait for seller to accept (Stripe mode: accept + fund is atomic)
await protocol.acceptEscrow(escrow.id);  // seller calls this — returns status 'active'
// On-chain mode (Phase 4): seller calls acceptEscrow(), then both parties fund via contract

// 5. Receive and deliver (seller side)
const results = await performWebSearch(query);
await protocol.deliver(escrow.escrowId, { results });
// Gateway runs AR verification automatically
// If pass: escrow releases. If fail: escrow refunds.

// 6. Record observation
protocol.recordObservation(counterpartyPubkey, { outcome: 'success' });
```

### 10.5 MCP Tools

```typescript
export const MCP_TOOLS = [
  // ── Discovery ──
  {
    name: 'trust_search_agents',
    description: 'Search for agents by capabilities. Use to discover counterparties.',
  },
  // ── Pre-transaction ──
  {
    name: 'trust_verify_agent',
    description: 'Verify an agent controls the identity it claims. Call before any interaction.',
  },
  {
    name: 'trust_suggest_collateral',
    description: 'Get a suggested collateral ratio based on counterparty history and attestations.',
  },
  // ── Transaction lifecycle ──
  {
    name: 'trust_propose_escrow',
    description: 'Propose a transaction with escrow protection and formal acceptance criteria. '
      + 'Both parties deposit collateral. Deliverables are verified automatically against '
      + 'the acceptance policy — no manual confirmation needed for most tasks.',
  },
  {
    name: 'trust_escrow_status',
    description: 'Check current status of an escrow. Poll to see if counterparty accepted, '
      + 'delivered, or if verification completed.',
  },
  {
    name: 'trust_deliver',
    description: 'Submit a deliverable for an escrow. The Verification Gateway checks it '
      + 'against the formal acceptance policy. If it passes, escrow releases automatically. '
      + 'If it fails, escrow refunds the buyer.',
  },
  {
    name: 'trust_dispute',
    description: 'Dispute a transaction. Warning: in burn mode, disputing costs you your '
      + 'deposit too. Only dispute if accepting the deliverable is worse than losing your deposit.',
  },
  // ── Policy authoring ──
  {
    name: 'trust_create_policy',
    description: 'Create formal acceptance criteria from a natural language description. '
      + 'Use when defining a new task type. Optionally refine with adversarial testing.',
  },
];
```

**8 tools**, organized by agent decision timeline: discover → verify → assess risk → propose → monitor → deliver → dispute → author policies.

### 10.6 Quick Start

From `npm install` to a test transaction in under 5 minutes:

```typescript
import { quickStart } from '@trustthenverify/sdk'

// 1. One line: generates keypair, registers agent, returns ready-to-use client
const ttv = await quickStart({ sandbox: true })

// 2. Browse available agents
const { agents } = await searchAgents(['web-search'])

// 3. Propose an escrow using a pre-built policy template (no policy creation needed)
const escrow = await ttv.proposeEscrow({
  seller: agents[0].publicKey,
  amountCents: 100,
  collateralRatio: 0.5,
  taskSpec: { type: 'web-search', query: 'AI frameworks 2026' },
  policyId: 'web_search_v1',
  verificationMethod: 'automated_reasoning',
})
```

`quickStart()` handles the crypto bootstrapping that would otherwise take hours:
- Generates a secp256k1 keypair (in sandbox: auto-generated test key)
- Registers the agent with the sandbox API
- Returns a configured `TrustProtocol` instance ready for transactions
- Uses pre-funded test wallets — no real money at risk

**When ready for production:** replace `{ sandbox: true }` with `{ publicKey, privateKey }` and point to the production API. The protocol logic is identical.

---

## 11. Build Order

Each phase is independently deployable and produces a usable system.

### Phase 0 — Foundation (1–2 weeks)
1. Supabase schema (6 tables, 8 indexes)
2. secp256k1 keypair generation in SDK (client-side)
3. Agent registration + verification endpoints
4. Signature verification middleware
5. Basic agent lookup and search
6. CI pipeline
7. Sandbox environment (§9.6): sandbox API endpoint, API key auth, test wallets
8. SDK `quickStart()` convenience method (§10.6)
9. Pre-built policy templates for common task types (§10.3)

**Deliverable:** Agents register and discover each other. Developers can go from `npm install` to a test transaction in <5 minutes via sandbox mode.

### Phase 1 — Escrow Protocol (2–3 weeks)
7. Escrow lifecycle API (propose → accept → fund → deliver → confirm → dispute)
8. Stripe Connect escrow (trusted, fast to ship)
9. Buyer-confirm verification method
10. Burn-on-dispute logic
11. Escrow timeout cron (Cloudflare Cron Trigger)
12. Local observation recording in SDK

**Deliverable:** Two agents can transact with Stripe-backed escrow and manual confirmation. Core protocol works.

### Phase 2 — Policy Engine (3–4 weeks)

13. `formal_spec` JSON schema definition and validator (§3.1.1)
14. Tier 1 constraint solver in Worker (all deterministic types from §3.1.2)
15. Tier 2 semantic constraint integration via Workers AI (similarity, relevance, coherence)
16. Policy creation endpoint with dual-provider translation pipeline (§3.1.4)
17. Coverage map generation and `policy_coverage` table
18. Policy lifecycle state machine (`draft → validated → approved → active → deprecated`)
19. Cross-validation integration (second LLM provider)
20. `automated_reasoning` verification method in Gateway
21. Gateway-triggered escrow release (`gatewayRelease()`)
22. Schema validation verification method
23. Pre-built policy templates for common task types (web search, summarization, code execution, data retrieval)
24. Creator-funded billing via Stripe for policy creation (§3.1.5)

**Deliverable:** Tasks with formal policies are verified automatically. Coverage maps surface gaps at authoring time. No buyer confirmation needed. Dispute rate drops dramatically.

### Phase 3 — Argus Codex (2–3 weeks)

25. Adversarial refinement engine (LLM pair via Cloudflare Queue)
26. Refinement API (async trigger + status polling)
27. Policy versioning (refined policies link to parent versions, old versions auto-deprecated)
28. Coverage estimation with early-stop logic (200 consecutive rounds, no exploit)
29. Exploit logging in `argus_exploits` JSONB
30. Auto-approval for high-coverage Tier-1-only policies (≥0.9 coverage, no Tier 2)
31. Policy template marketplace (community-refined policies, revenue share)
32. Platform-amortized billing model for TTV default templates

**Deliverable:** Policies are adversarially tested before deployment. Policy gaps caught before they become exploits. Marketplace enables cost sharing across developers.

### Phase 4 — On-Chain Escrow (3–4 weeks)
33. Base L2 escrow smart contract (factory + instance)
34. USDC deposit/release logic
35. `gatewayRelease()` in contract (Gateway signs, contract verifies)
36. Smart contract tests
37. Dual-mode: Stripe or on-chain, per transaction
38. Payment channels for micro-transactions

**Deliverable:** Trustless on-chain escrow for agents that want it.

### Phase 5 — Attestations (1–2 weeks)
39. Attestation signing and Nostr publishing
40. Attestation query
41. `suggestCollateral()` using attestations + on-chain history
42. SDK integration

**Deliverable:** Organic reputation emerges from transaction outcomes.

### Phase 6 — Oracle Verification (2–3 weeks)
43. Oracle agent pool (opt-in registration, capability tags, withdraw)
44. Oracle dispatch via Cloudflare Queue (select 5, exclude parties, fallback)
45. Oracle consensus logic (quorum 3/5, early termination, timeout sweep)
46. Oracle payment — platform-funded, all voters paid (see §3.5.4)
47. `oracle_consensus` verification method wired into deliver route + cron
48. Oracle API: join, withdraw, status, tasks, vote, task detail (see §3.5.7)
49. SDK types and TrustProtocol methods for oracle interaction

**Deliverable:** Subjective tasks verified by independent oracle consensus. Full design in §3.5.

### Phase 7 — Stripe Connect (1–2 weeks) ✅

48. Stripe Customer + Express Connected Account onboarding routes
49. Dual PaymentIntent escrow (buyer payment + seller collateral)
50. Game-theoretic resolution parity with on-chain (release/fail/burn)
51. SDK methods: `setupStripeCustomer()`, `setupStripeConnect()`, `attachPaymentMethod()`, `getStripeStatus()`
52. Sandbox mode bypass for Stripe validation (E2E testable without live Stripe)

**Deliverable:** Full Stripe-mode escrow with per-agent identity, collateral enforcement, and outcome-based fund distribution.

### Phase 8 — zkML Integration (when technology matures)
53. `zkml_proof` verification method in Gateway
54. Proof verification logic (constant-time, ~300ms)
55. SDK: proof submission alongside deliverables
56. Escrow contract: accept proof as release trigger
57. Gateway self-verification (wrap Gateway's own AR logic in zkML proof)

**Deliverable:** Cryptographic proof of execution compliance. Escrow becomes optional for proven tasks.

### Phase 9 — Arbitration (ongoing)
58. Arbitrator registry
59. Arbitrator assignment (random from qualified pool)
60. Ruling submission and escrow resolution
61. Arbitrator reputation tracking

**Deliverable:** High-value disputes have a resolution path.

**Estimated build time: Phases 0–5 in 12–17 weeks.** (Phase 2 expanded by ~1 week for translation pipeline and coverage map.) Phases 6–9 are ongoing. Phase 8 depends on external zkML maturation.

---

## 12. Tradeoffs & Open Questions

### 12.1 What This Architecture Does Well

| Property | How |
|---|---|
| Cold start | Post collateral. Transact immediately. No history needed. |
| Autonomous verification | AR policy engine removes humans from 80%+ of verifications |
| No trusted third party | On-chain escrow. Gateway is verifiable (signed results, future: zkML proofs) |
| Sybil resistance | Collateral is natural sybil resistance |
| Complexity | Spec is dense but modular — each section is self-contained |
| Time to first transaction | Seconds (register + fund escrow) |
| Policy completeness | Argus Codex adversarial refinement, reusable across transactions |

### 12.2 What This Architecture Does Poorly

| Property | Why |
|---|---|
| Fiat accessibility | On-chain escrow needs USDC. Mitigated by Stripe mode. |
| Human legibility | No simple score. "98.5% escrow completion rate" < "Score: 74" |
| Subjective quality | AR verifies compliance, not quality. Burn mechanism is the fallback. |
| Gateway trust | Gateway signs verification results but could lie. Mitigated by: (a) signed logs are auditable, (b) future zkML proofs eliminate Gateway trust entirely. |
| Policy translation quality | Natural language → formal logic is imperfect. Bad translation → bad verification. Mitigated by Argus Codex catching gaps. |

### 12.3 Open Questions for Benno Framework Integration

1. **What model sizes can JOLT Atlas actually prove today?** The paper cites 10,000× overhead but doesn't specify model scale. Most useful agents run 7B+ parameter models. If proving is limited to small classifiers, the zkML layer is further out than the paper implies.

2. ~~**How does AR verification handle semantic constraints?**~~ **RESOLVED (§3.1.2).** Two-tier architecture: Tier 1 (deterministic) constraints run in-Worker <100ms. Tier 2 (semantic) constraints use Cloudflare Workers AI for embeddings/classification, extending verification budget to <5s. Tier 2 is explicitly marked and discouraged — Argus Codex prefers Tier 1 patches.

3. ~~**Who pays for Argus Codex refinement?**~~ **RESOLVED (§3.1.5).** Three-model progression: creator-funded at launch, platform-amortized with transaction volume, marketplace with revenue share. Policy template marketplace spreads cost.

4. ~~**How does the protocol handle evolving task types?**~~ **RESOLVED (§3.1.3).** Weekly cron checks dispute rate per active policy. If rate exceeds 5% threshold, policy flagged as stale, creator notified, optional auto-re-refinement for platform/marketplace policies. Simple, observable, no new infrastructure.

5. ~~**The Gateway is a centralization pressure point.**~~ **RESOLVED for launch (§8.1.1).** Single Gateway key in Workers secrets, owner can rotate, all results signed and logged. Multi-Gateway is a future concern. Accept the centralization tradeoff — it's honest and the mitigation stack (auditability + rotation + future zkML) is adequate.

6. ~~**Translation pipeline provider lock-in.**~~ **RESOLVED (§3.1.4).** Translator and cross-validator are roles, not specific models. Abstract behind a common interface. If one provider degrades, swap it — the pipeline logic doesn't change, only the API call.

7. ~~**Constraint language extensibility.**~~ **RESOLVED (§3.1.2).** Tier 1 is a fixed set of 15 types. If a task needs something the solver doesn't support, fall back to Tier 2 semantic check. If a Tier 2 pattern becomes common, promote it to Tier 1 in a Worker redeployment. Don't over-engineer the constraint language — the system covers 90% of verifiable tasks. The other 10% use `buyer_confirm` or escrow burn. That's what those mechanisms are for.

---

## 13. Migration Path from v1

v1 and v2 are not mutually exclusive.

1. **Build v2 escrow + verification alongside v1 scoring.** Agents use either or both.
2. **v1 trust scores become one input to `suggestCollateral()`.** High v1 score → lower suggested collateral. Useful but not authoritative.
3. **v1 challenges become policy templates.** The behavioral and adversarial challenges in v1 §4.9 are essentially AR acceptance criteria. Convert them to formal policies in the v2 policy engine.
4. **Over time, escrow completion history + AR verification results replace v1 scores** as the primary trust signal — because they're based on economic commitments and formal proofs, not challenge test results and reviews.
5. **v1 infrastructure (KV cache, R2 archive, score engine) deprecated** when escrow + AR provides equivalent or better signal.

No flag day. Let the market decide.
