/**
 * Argus Codex prompt templates — pure functions returning prompt strings
 * and response parsers. Per SPEC-v2 §11 items 25-30.
 */

import { extractJSON } from './extract-json'

export interface ParsedAdversaryResponse {
  exploit: Record<string, unknown>
  explanation: string
}

export interface ParsedRefinementResponse {
  formalSpec: Record<string, unknown>
}

/**
 * Adversary prompt: generate a deliverable that satisfies constraints
 * but violates the intent.
 */
export function adversaryPrompt(intent: string, formalSpec: Record<string, unknown>): string {
  return `You are an adversarial auditor testing a verification policy.

INTENT (what the policy is supposed to enforce):
${intent}

FORMAL SPEC (the machine-checkable constraints):
${JSON.stringify(formalSpec, null, 2)}

Your task: Generate a JSON deliverable that PASSES all the formal constraints above but VIOLATES the stated intent. The deliverable should be technically compliant but semantically wrong — it satisfies the letter of the spec but not the spirit.

Respond with ONLY a JSON object in this exact format:
{
  "exploit": { ... the deliverable that passes constraints but violates intent ... },
  "explanation": "Brief explanation of how this exploit bypasses the intent"
}

If you cannot find an exploit (the constraints fully capture the intent), respond with:
{ "exploit": null, "explanation": "No exploit found" }`
}

/**
 * Refinement prompt: patch the formal_spec to block a discovered exploit.
 */
export function refinementPrompt(
  intent: string,
  formalSpec: Record<string, unknown>,
  exploit: Record<string, unknown>,
  explanation: string,
): string {
  return `You are a policy refinement assistant.

INTENT: ${intent}

CURRENT FORMAL SPEC:
${JSON.stringify(formalSpec, null, 2)}

EXPLOIT FOUND:
${JSON.stringify(exploit, null, 2)}

EXPLANATION: ${explanation}

Your task: Patch the formal_spec to block this exploit while preserving all existing constraints. You may add new constraints or tighten existing ones. Prefer Tier 1 constraint types (exists, type, range, length, count, contains, regex, one_of, format, schema, all, any, none, compare, overlap). Only use Tier 2 types (semantic_similarity, topic_relevance, coherence) if Tier 1 cannot block the exploit.

Rules:
- Keep version: 1
- Each constraint needs: id (unique string), type, target (JSONPath starting with $), params
- Tier 2 params need: min_score (0-1), reference_target (string) for semantic_similarity/topic_relevance

Respond with ONLY a JSON object in this exact format:
{
  "formal_spec": { "version": 1, "constraints": [ ... ] },
  "tier2_introduced": false
}`
}

/**
 * Parse adversary LLM response. Handles raw JSON, markdown code blocks, garbage.
 */
export function parseAdversaryResponse(raw: string): ParsedAdversaryResponse | null {
  const json = extractJSON(raw)
  if (!json) return null

  try {
    const parsed = JSON.parse(json)

    // No exploit found
    if (parsed.exploit === null) return null

    if (!parsed.exploit || typeof parsed.exploit !== 'object') return null
    if (typeof parsed.explanation !== 'string') return null

    return {
      exploit: parsed.exploit,
      explanation: parsed.explanation,
    }
  } catch {
    return null
  }
}

/**
 * Parse refinement LLM response. Returns patched formal_spec.
 */
export function parseRefinementResponse(raw: string): ParsedRefinementResponse | null {
  const json = extractJSON(raw)
  if (!json) return null

  try {
    const parsed = JSON.parse(json)

    const spec = parsed.formal_spec
    if (!spec || typeof spec !== 'object') return null
    if (spec.version !== 1) return null
    if (!Array.isArray(spec.constraints)) return null

    return { formalSpec: spec }
  } catch {
    return null
  }
}

