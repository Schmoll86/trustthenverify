/**
 * FormalSpec validator — checks structural integrity of a formal_spec JSONB.
 * Per SPEC-v2 §3.1.1.
 */

const TIER1_TYPES = new Set([
  'exists', 'type', 'range', 'length', 'count', 'contains', 'regex',
  'one_of', 'format', 'schema', 'all', 'any', 'none', 'compare', 'overlap',
])

const TIER2_TYPES = new Set([
  'semantic_similarity', 'topic_relevance', 'coherence',
])

const ALL_TYPES = new Set([...TIER1_TYPES, ...TIER2_TYPES])

const VALID_FORMATS = new Set(['uri', 'email', 'iso8601', 'uuid'])
const COMPARE_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'neq'])

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export function validateFormalSpec(spec: unknown): ValidationResult {
  const errors: string[] = []

  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { valid: false, errors: ['formal_spec must be an object'] }
  }

  const s = spec as Record<string, unknown>

  if (s.version !== 1) {
    errors.push('formal_spec.version must be 1')
  }

  if (!Array.isArray(s.constraints)) {
    errors.push('formal_spec.constraints must be an array')
    return { valid: false, errors }
  }

  const ids = new Set<string>()

  for (let i = 0; i < s.constraints.length; i++) {
    validateConstraint(s.constraints[i], `constraints[${i}]`, ids, errors, 0)
  }

  return { valid: errors.length === 0, errors }
}

function validateConstraint(
  c: unknown,
  path: string,
  ids: Set<string>,
  errors: string[],
  depth: number,
): void {
  if (depth > 3) {
    errors.push(`${path}: nesting depth exceeds limit of 3`)
    return
  }

  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    errors.push(`${path}: constraint must be an object`)
    return
  }

  const constraint = c as Record<string, unknown>

  // id
  if (typeof constraint.id !== 'string' || !constraint.id) {
    errors.push(`${path}: id is required and must be a non-empty string`)
  } else if (ids.has(constraint.id)) {
    errors.push(`${path}: duplicate constraint id "${constraint.id}"`)
  } else {
    ids.add(constraint.id)
  }

  // type
  if (typeof constraint.type !== 'string') {
    errors.push(`${path}: type is required and must be a string`)
  } else if (!ALL_TYPES.has(constraint.type)) {
    errors.push(`${path}: unknown constraint type "${constraint.type}"`)
  }

  // target
  if (typeof constraint.target !== 'string') {
    errors.push(`${path}: target is required and must be a string`)
  } else if (!constraint.target.startsWith('$')) {
    errors.push(`${path}: target must start with $`)
  }

  // params
  if (!constraint.params || typeof constraint.params !== 'object' || Array.isArray(constraint.params)) {
    errors.push(`${path}: params is required and must be an object`)
    return
  }

  const params = constraint.params as Record<string, unknown>
  const type = constraint.type as string

  // Type-specific param validation
  if (type === 'type') {
    const valid = ['string', 'number', 'boolean', 'array', 'object']
    if (!valid.includes(params.expected as string)) {
      errors.push(`${path}: params.expected must be one of: ${valid.join(', ')}`)
    }
  }

  if (type === 'compare') {
    if (typeof params.operator !== 'string' || !COMPARE_OPS.has(params.operator)) {
      errors.push(`${path}: params.operator must be one of: ${[...COMPARE_OPS].join(', ')}`)
    }
    if (typeof params.other_target !== 'string' || !params.other_target.startsWith('$')) {
      errors.push(`${path}: params.other_target must be a JSONPath starting with $`)
    }
  }

  if (type === 'format') {
    if (!VALID_FORMATS.has(params.format as string)) {
      errors.push(`${path}: params.format must be one of: ${[...VALID_FORMATS].join(', ')}`)
    }
  }

  if (type === 'regex') {
    if (typeof params.pattern !== 'string') {
      errors.push(`${path}: params.pattern must be a string`)
    }
  }

  if (type === 'overlap') {
    if (typeof params.other_target !== 'string' || !params.other_target.startsWith('$')) {
      errors.push(`${path}: params.other_target must be a JSONPath starting with $`)
    }
    if (typeof params.max_ratio !== 'number' || params.max_ratio < 0 || params.max_ratio > 1) {
      errors.push(`${path}: params.max_ratio must be a number between 0 and 1`)
    }
  }

  // Nested constraint types
  if (type === 'all' || type === 'any' || type === 'none') {
    if (!params.constraint || typeof params.constraint !== 'object') {
      errors.push(`${path}: params.constraint is required for ${type}`)
    } else {
      validateConstraint(params.constraint, `${path}.params.constraint`, ids, errors, depth + 1)
    }
  }

  // Tier 2 param validation
  if (type === 'semantic_similarity' || type === 'topic_relevance') {
    if (typeof params.reference_target !== 'string' || !params.reference_target) {
      errors.push(`${path}: params.reference_target is required for ${type}`)
    }
    if (params.min_score !== undefined) {
      if (typeof params.min_score !== 'number' || params.min_score < 0 || params.min_score > 1) {
        errors.push(`${path}: params.min_score must be a number between 0 and 1`)
      }
    }
  }

  if (type === 'coherence') {
    if (params.min_score !== undefined) {
      if (typeof params.min_score !== 'number' || params.min_score < 0 || params.min_score > 1) {
        errors.push(`${path}: params.min_score must be a number between 0 and 1`)
      }
    }
  }
}
