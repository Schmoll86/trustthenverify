/**
 * Translation service — orchestrates NL-to-formal_spec translation with retry.
 * Per SPEC-v2 §3.1.4, Phase 4.
 */

import type { LLMService } from './openrouter'
import {
  translatorPrompt,
  crossValidationPrompt,
  parseTranslatorResponse,
  parseCrossValidationResponse,
  type TranslatorClause,
  type ParsedCrossValidationResponse,
} from './translation-prompts'
import { validateFormalSpec } from './validate-formal-spec'
import { isTier2 } from './solver-tier2'

export interface TranslationResult {
  status: 'validated' | 'draft'
  formalSpec: Record<string, unknown>
  clauses: TranslatorClause[]
  translationModel: string
  crossValidatorModel: string | null
  crossValidation: ParsedCrossValidationResponse | null
  tier2Used: boolean
  errors?: string[]
}

const MAX_TRANSLATE_RETRIES = 3
const MAX_CROSS_VALIDATE_RETRIES = 1

export async function translatePolicy(params: {
  intent: string
  clauses?: Array<{ index: number; text: string }>
  llm: LLMService
  translatorModel: string
  crossValidatorModel: string
}): Promise<TranslationResult> {
  const { intent, clauses, llm, translatorModel, crossValidatorModel } = params

  // Step 1: Translate with retries
  let formalSpec: { version: number; constraints: Array<Record<string, unknown>> } | null = null
  let translatedClauses: TranslatorClause[] = []
  const errors: string[] = []
  let lastError = ''

  for (let attempt = 0; attempt < MAX_TRANSLATE_RETRIES; attempt++) {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: translatorPrompt(intent, clauses) },
    ]

    if (attempt > 0 && lastError) {
      messages.push({
        role: 'assistant',
        content: 'I apologize for the error.',
      })
      messages.push({
        role: 'user',
        content: `Your previous response was invalid. Error: ${lastError}\n\nPlease try again with valid JSON matching the exact format specified.`,
      })
    }

    let raw: string
    try {
      raw = await llm.complete({
        model: translatorModel,
        messages,
        maxTokens: 4096,
        temperature: 0.2,
      })
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'LLM call failed'
      errors.push(`Attempt ${attempt + 1}: ${lastError}`)
      continue
    }

    const parsed = parseTranslatorResponse(raw)
    if (!parsed) {
      lastError = 'Response was not valid JSON matching expected format'
      errors.push(`Attempt ${attempt + 1}: ${lastError}`)
      continue
    }

    // Validate the generated formal_spec
    const validation = validateFormalSpec(parsed.formalSpec)
    if (!validation.valid) {
      lastError = `formal_spec validation failed: ${validation.errors.join('; ')}`
      errors.push(`Attempt ${attempt + 1}: ${lastError}`)
      continue
    }

    formalSpec = parsed.formalSpec
    translatedClauses = parsed.clauses
    break
  }

  // Translation failed after all retries
  if (!formalSpec) {
    return {
      status: 'draft',
      formalSpec: { version: 1, constraints: [] },
      clauses: [],
      translationModel: translatorModel,
      crossValidatorModel: null,
      crossValidation: null,
      tier2Used: false,
      errors,
    }
  }

  // Step 2: Detect tier2 usage
  const tier2Used = formalSpec.constraints.some(
    (c: Record<string, unknown>) => typeof c.type === 'string' && isTier2(c.type),
  )

  // Step 3: Cross-validate
  let crossValidation: ParsedCrossValidationResponse | null = null

  for (let attempt = 0; attempt <= MAX_CROSS_VALIDATE_RETRIES; attempt++) {
    try {
      const raw = await llm.complete({
        model: crossValidatorModel,
        messages: [
          { role: 'user', content: crossValidationPrompt(intent, formalSpec, translatedClauses) },
        ],
        maxTokens: 4096,
        temperature: 0.2,
      })

      const parsed = parseCrossValidationResponse(raw)
      if (parsed) {
        crossValidation = parsed
        break
      }
    } catch {
      // Cross-validation failure is non-fatal
    }
  }

  // Step 4: Determine final status
  if (crossValidation?.verdict === 'fail') {
    return {
      status: 'draft',
      formalSpec,
      clauses: translatedClauses,
      translationModel: translatorModel,
      crossValidatorModel: crossValidatorModel,
      crossValidation,
      tier2Used,
    }
  }

  // Check for uncovered clauses without notes
  const hasUncovered = translatedClauses.some(c => c.status === 'uncovered')
  if (hasUncovered) {
    return {
      status: 'draft',
      formalSpec,
      clauses: translatedClauses,
      translationModel: translatorModel,
      crossValidatorModel: crossValidation ? crossValidatorModel : null,
      crossValidation,
      tier2Used,
    }
  }

  return {
    status: 'validated',
    formalSpec,
    clauses: translatedClauses,
    translationModel: translatorModel,
    crossValidatorModel: crossValidation ? crossValidatorModel : null,
    crossValidation,
    tier2Used,
  }
}
