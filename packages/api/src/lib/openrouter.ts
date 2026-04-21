/**
 * OpenRouter LLM abstraction — interface-based, follows AIService/GatewayService pattern.
 * Per Phase 4: NL-to-Formal Translation Pipeline.
 *
 * Cost capture: request body includes `usage: { include: true }` so OpenRouter
 * returns `usage.total_cost` (USD float) in the response. We round to cents
 * and surface on every call. If the field is absent or zero we return 0 and
 * warn once per process-lifetime per model — never throw.
 */

export interface LLMCompletion {
  content: string
  costCents: number
}

export interface LLMService {
  complete(params: {
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    maxTokens?: number
    temperature?: number
  }): Promise<LLMCompletion>
}

const warnedModels = new Set<string>()

function usdToCents(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0
  return Math.round(usd * 100)
}

export class RealLLMService implements LLMService {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  async complete(params: {
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    maxTokens?: number
    temperature?: number
  }): Promise<LLMCompletion> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 25_000) // 25s timeout (Workers wall-clock limit is 30s)

    let response: Response
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://trustthenverify.com',
          'X-Title': 'TrustThenVerify',
        },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
          max_tokens: params.maxTokens ?? 4096,
          temperature: params.temperature ?? 0.2,
          usage: { include: true },
        }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeoutId)
      throw new Error(`OpenRouter request failed: ${err instanceof Error ? err.message : 'timeout'}`)
    }
    clearTimeout(timeoutId)

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`OpenRouter ${response.status}: ${text}`)
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { total_cost?: number; cost?: number }
    }

    const content = data.choices?.[0]?.message?.content
    if (!content) {
      throw new Error('OpenRouter returned empty content')
    }

    // OpenRouter surfaces cost as `usage.total_cost` (preferred) or `usage.cost`
    // depending on account tier. If both are missing for a model, log once.
    const rawCost = data.usage?.total_cost ?? data.usage?.cost
    const costCents = typeof rawCost === 'number' ? usdToCents(rawCost) : 0
    if (costCents === 0 && rawCost == null && !warnedModels.has(params.model)) {
      warnedModels.add(params.model)
      console.warn(`[openrouter] No usage.total_cost returned for model: ${params.model}`)
    }

    return { content, costCents }
  }
}
