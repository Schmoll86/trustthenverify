/**
 * Arbitration prompts — LLM judge instructions for dispute resolution.
 * Single round of arbitration: one LLM reviews evidence and rules.
 */

import { extractJSON } from './extract-json.js'

export interface ArbitrationEvidence {
  escrowId: string
  taskSpec: Record<string, unknown>
  policy: { intent: string; formalSpec?: Record<string, unknown> } | null
  verificationResults: Array<{ method: string; result: string; failures?: unknown[] }> | null
  disputeReason: string
  initiatorRole: 'buyer' | 'seller'
  amountCents: number
  deliverable?: Record<string, unknown> | null
}

export interface ArbitrationRuling {
  ruling: 'buyer_wins' | 'seller_wins'
  rationale: string
  confidence: number
}

export function arbitrationSystemPrompt(): string {
  return `You are an impartial arbitrator for an AI agent escrow platform. Your job is to review evidence from a disputed transaction and rule fairly.

You will receive:
- The task specification (what was agreed upon)
- The policy (if any) defining quality requirements
- Verification results (if any) from automated checks
- The dispute reason from the initiating party
- The deliverable (if submitted)

Rules:
1. You MUST rule either "buyer_wins" or "seller_wins". No other outcome.
2. Buyer wins if the deliverable is missing, substantially incomplete, or clearly fails the task spec.
3. Seller wins if the deliverable reasonably satisfies the task spec, even if imperfect.
4. Give benefit of the doubt to the party with stronger evidence.
5. If verification results show "pass", that weighs heavily in seller's favor.
6. If verification results show "fail", that weighs heavily in buyer's favor.
7. Be concise in your rationale (2-3 sentences max).

Respond with JSON only:
{
  "ruling": "buyer_wins" | "seller_wins",
  "rationale": "Brief explanation",
  "confidence": 0.0 to 1.0
}`
}

export function arbitrationUserPrompt(evidence: ArbitrationEvidence): string {
  const sections: string[] = []

  sections.push(`## Escrow ID\n${evidence.escrowId}`)
  sections.push(`## Amount\n$${(evidence.amountCents / 100).toFixed(2)}`)
  sections.push(`## Task Specification\n${JSON.stringify(evidence.taskSpec, null, 2)}`)

  if (evidence.policy) {
    sections.push(`## Policy\nIntent: ${evidence.policy.intent}`)
    if (evidence.policy.formalSpec) {
      sections.push(`Formal Spec: ${JSON.stringify(evidence.policy.formalSpec, null, 2)}`)
    }
  }

  if (evidence.deliverable) {
    sections.push(`## Deliverable\n${JSON.stringify(evidence.deliverable, null, 2)}`)
  } else {
    sections.push(`## Deliverable\nNo deliverable was submitted.`)
  }

  if (evidence.verificationResults && evidence.verificationResults.length > 0) {
    const vr = evidence.verificationResults.map(v =>
      `- Method: ${v.method}, Result: ${v.result}${v.failures?.length ? `, Failures: ${JSON.stringify(v.failures)}` : ''}`
    ).join('\n')
    sections.push(`## Verification Results\n${vr}`)
  }

  sections.push(`## Dispute\nFiled by: ${evidence.initiatorRole}\nReason: ${evidence.disputeReason}`)

  return sections.join('\n\n')
}

export function parseArbitrationRuling(raw: string): ArbitrationRuling | null {
  const jsonStr = extractJSON(raw)
  if (!jsonStr) return null

  try {
    const parsed = JSON.parse(jsonStr)
    if (parsed.ruling !== 'buyer_wins' && parsed.ruling !== 'seller_wins') return null
    return {
      ruling: parsed.ruling,
      rationale: String(parsed.rationale ?? ''),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    }
  } catch {
    return null
  }
}
