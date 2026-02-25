/**
 * Shared JSON extraction utility — extracts JSON from raw LLM output.
 * Handles raw JSON, markdown ```json ... ``` blocks, JSON embedded in text.
 */

export function extractJSON(raw: string): string | null {
  const trimmed = raw.trim()

  // Try raw JSON first
  if (trimmed.startsWith('{')) {
    return trimmed
  }

  // Try markdown code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim()
  }

  // Try to find JSON object in text
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    return jsonMatch[0]
  }

  return null
}
