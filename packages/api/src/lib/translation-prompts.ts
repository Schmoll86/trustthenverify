/**
 * Translation pipeline prompts — pure functions returning prompt strings
 * and response parsers. Per SPEC-v2 §3.1.4, Phase 4.
 */

import { extractJSON } from './extract-json'

export interface TranslatorClause {
  index: number
  text: string
  constraint_ids: string[]
  status: 'covered' | 'uncovered'
}

export interface ParsedTranslatorResponse {
  formalSpec: { version: number; constraints: Array<Record<string, unknown>> }
  clauses: TranslatorClause[]
  uncoveredClauses: number[]
  attackSurfaces: string[]
}

export interface ParsedCrossValidationResponse {
  contradictions: string[]
  uncoveredClauses: string[]
  exploit: { example: Record<string, unknown>; explanation: string } | null
  verdict: 'pass' | 'fail'
}

/**
 * Four-phase translator prompt per §3.1.4:
 * 1. Constraint enumeration (obligations, prohibitions, permissions)
 * 2. Attack surface analysis
 * 3. JSON generation (formal_spec format with clauseRef tags)
 * 4. Self-coverage audit
 */
export function translatorPrompt(
  intent: string,
  clauses?: Array<{ index: number; text: string }>,
): string {
  const clauseSection = clauses && clauses.length > 0
    ? `\nNL CLAUSES (pre-split by caller):\n${clauses.map(c => `  [${c.index}] ${c.text}`).join('\n')}\n`
    : `\nNo pre-split clauses provided. You must split the intent into individual clauses yourself and number them starting from 0.\n`

  return `You are a formal verification policy translator. Your job is to convert natural language policy intent into a machine-checkable formal_spec JSON.

INTENT:
${intent}
${clauseSection}
Follow these four phases IN ORDER:

## Phase 1: Constraint Enumeration
Analyze the intent and identify ALL:
- Obligations (MUST do)
- Prohibitions (MUST NOT do)
- Permissions (MAY do, with bounds)
Include both explicitly stated AND implied constraints.

## Phase 2: Attack Surface Analysis
For each constraint, consider how a malicious actor could technically satisfy the constraint while violating the spirit of the intent. List attack surfaces.

## Phase 3: JSON Generation
Generate a formal_spec JSON object. Rules:
- version: 1
- Each constraint needs: id (unique string like "c1", "c2"), type, target (JSONPath starting with $), params
- Add a "clauseRef" field to each constraint linking it to the NL clause index it covers
- Available Tier 1 types: exists, type, range, length, count, contains, regex, one_of, format, schema, all, any, none, compare, overlap
- Only use Tier 2 types (semantic_similarity, topic_relevance, coherence) if Tier 1 absolutely cannot express the constraint
- Tier 2 params need: min_score (0-1), reference_target (string) for semantic_similarity/topic_relevance

## Phase 4: Self-Coverage Audit
Check each NL clause. Flag any clause that has NO constraint covering it.

Respond with ONLY a JSON object in this exact format:
{
  "formal_spec": { "version": 1, "constraints": [ ... ] },
  "clauses": [
    { "index": 0, "text": "clause text", "constraint_ids": ["c1"], "status": "covered" },
    { "index": 1, "text": "clause text", "constraint_ids": [], "status": "uncovered" }
  ],
  "uncovered_clauses": [1],
  "attack_surfaces": ["description of potential attack vector"]
}`
}

/**
 * Cross-validation prompt — three questions per §3.1.4:
 * 1. Any constraint contradicts intent?
 * 2. Any NL clause lacks a constraint?
 * 3. Can you construct output satisfying constraints but violating intent?
 */
export function crossValidationPrompt(
  intent: string,
  formalSpec: Record<string, unknown>,
  clauses: TranslatorClause[],
): string {
  return `You are a cross-validation auditor for formal verification policies. A different AI translated the following intent into constraints. Your job is to find flaws.

INTENT:
${intent}

FORMAL SPEC:
${JSON.stringify(formalSpec, null, 2)}

NL CLAUSES WITH COVERAGE:
${clauses.map(c => `  [${c.index}] "${c.text}" → constraints: [${c.constraint_ids.join(', ')}] (${c.status})`).join('\n')}

Answer these three questions:

1. CONTRADICTIONS: Do any constraints contradict the stated intent? List them.
2. UNCOVERED CLAUSES: Are there NL clauses that lack adequate constraint coverage? List them.
3. EXPLOIT: Can you construct a concrete JSON deliverable that would PASS all the formal constraints but VIOLATE the intent? If yes, provide the example and explanation. If no, say null.

Respond with ONLY a JSON object in this exact format:
{
  "contradictions": ["description of contradiction, or empty array if none"],
  "uncovered_clauses": ["description of uncovered clause, or empty array if none"],
  "exploit": null,
  "verdict": "pass"
}

If you found contradictions, uncovered clauses, OR an exploit, set verdict to "fail".
If the constraints adequately capture the intent, set verdict to "pass".`
}

/**
 * Parse translator LLM response. Returns typed result or null.
 */
export function parseTranslatorResponse(raw: string): ParsedTranslatorResponse | null {
  const json = extractJSON(raw)
  if (!json) return null

  try {
    const parsed = JSON.parse(json)

    const spec = parsed.formal_spec
    if (!spec || typeof spec !== 'object') return null
    if (spec.version !== 1) return null
    if (!Array.isArray(spec.constraints)) return null

    const clauses: TranslatorClause[] = []
    if (Array.isArray(parsed.clauses)) {
      for (const c of parsed.clauses) {
        if (typeof c.index !== 'number') continue
        clauses.push({
          index: c.index,
          text: typeof c.text === 'string' ? c.text : '',
          constraint_ids: Array.isArray(c.constraint_ids) ? c.constraint_ids : [],
          status: c.status === 'uncovered' ? 'uncovered' : 'covered',
        })
      }
    }

    const uncoveredClauses = Array.isArray(parsed.uncovered_clauses)
      ? parsed.uncovered_clauses.filter((x: unknown) => typeof x === 'number')
      : []

    const attackSurfaces = Array.isArray(parsed.attack_surfaces)
      ? parsed.attack_surfaces.filter((x: unknown) => typeof x === 'string')
      : []

    return { formalSpec: spec, clauses, uncoveredClauses, attackSurfaces }
  } catch {
    return null
  }
}

/**
 * Parse cross-validation LLM response. Returns typed result or null.
 */
export function parseCrossValidationResponse(raw: string): ParsedCrossValidationResponse | null {
  const json = extractJSON(raw)
  if (!json) return null

  try {
    const parsed = JSON.parse(json)

    if (parsed.verdict !== 'pass' && parsed.verdict !== 'fail') return null

    const contradictions = Array.isArray(parsed.contradictions)
      ? parsed.contradictions.filter((x: unknown) => typeof x === 'string')
      : []

    const uncoveredClauses = Array.isArray(parsed.uncovered_clauses)
      ? parsed.uncovered_clauses.filter((x: unknown) => typeof x === 'string')
      : []

    let exploit: ParsedCrossValidationResponse['exploit'] = null
    if (parsed.exploit && typeof parsed.exploit === 'object' && parsed.exploit.example) {
      exploit = {
        example: parsed.exploit.example,
        explanation: typeof parsed.exploit.explanation === 'string'
          ? parsed.exploit.explanation
          : '',
      }
    }

    return { contradictions, uncoveredClauses, exploit, verdict: parsed.verdict }
  } catch {
    return null
  }
}
