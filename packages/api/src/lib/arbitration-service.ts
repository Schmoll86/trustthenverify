/**
 * ArbitrationService — LLM-based dispute arbitration.
 * Follows GatewayService pattern: interface + real impl + test injection.
 * Single round: one LLM call reviews evidence and rules.
 */

import type { LLMService } from './openrouter.js'
import type { ArbitrationEvidence, ArbitrationRuling } from './arbitration-prompts.js'
import { arbitrationSystemPrompt, arbitrationUserPrompt, parseArbitrationRuling } from './arbitration-prompts.js'

export interface ArbitrationService {
  arbitrate(evidence: ArbitrationEvidence): Promise<ArbitrationRuling>
}

export class RealArbitrationService implements ArbitrationService {
  private llm: LLMService
  private model: string

  constructor(llm: LLMService, model: string) {
    this.llm = llm
    this.model = model
  }

  async arbitrate(evidence: ArbitrationEvidence): Promise<ArbitrationRuling> {
    const messages = [
      { role: 'system' as const, content: arbitrationSystemPrompt() },
      { role: 'user' as const, content: arbitrationUserPrompt(evidence) },
    ]

    // First attempt
    const raw = await this.llm.complete({
      model: this.model,
      messages,
      temperature: 0.1,
      maxTokens: 1024,
    })

    const ruling = parseArbitrationRuling(raw)
    if (ruling) return ruling

    // One retry on parse failure
    const raw2 = await this.llm.complete({
      model: this.model,
      messages: [
        ...messages,
        { role: 'assistant' as const, content: raw },
        { role: 'user' as const, content: 'Your response was not valid JSON. Please respond with ONLY a JSON object: { "ruling": "buyer_wins" | "seller_wins", "rationale": "...", "confidence": 0.0-1.0 }' },
      ],
      temperature: 0.0,
      maxTokens: 512,
    })

    const ruling2 = parseArbitrationRuling(raw2)
    if (ruling2) return ruling2

    throw new Error('Arbitration LLM failed to produce a valid ruling after retry')
  }
}
