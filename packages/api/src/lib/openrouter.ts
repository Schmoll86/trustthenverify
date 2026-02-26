/**
 * OpenRouter LLM abstraction — interface-based, follows AIService/GatewayService pattern.
 * Per Phase 4: NL-to-Formal Translation Pipeline.
 */

export interface LLMService {
  complete(params: {
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    maxTokens?: number
    temperature?: number
  }): Promise<string>
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
  }): Promise<string> {
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
    }

    const content = data.choices?.[0]?.message?.content
    if (!content) {
      throw new Error('OpenRouter returned empty content')
    }

    return content
  }
}
