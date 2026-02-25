/**
 * Tier 1 constraint solver — pure functions, no DB/network.
 * Per SPEC-v2 §3.1.2 / §4.1.
 *
 * 15 constraint types. JSONPath [*] = implicit ALL (every resolved value must pass).
 */

import { resolveTarget } from './jsonpath'

export interface ConstraintResult {
  id: string
  passed: boolean
  error?: string
}

export interface SolveAllResult {
  result: 'pass' | 'fail' | 'error'
  constraintsTotal: number
  constraintsPassed: number
  failures: Array<{ id: string; error: string }>
}

interface Constraint {
  id: string
  type: string
  target: string
  params: Record<string, unknown>
}

interface FormalSpec {
  version: number
  constraints: Constraint[]
}

// ── Public API ──────────────────────────────────────────────────────────────

export function solveConstraint(constraint: Constraint, deliverable: unknown): ConstraintResult {
  try {
    const values = resolveTarget(deliverable, constraint.target)
    const passed = checkConstraint(constraint, values, deliverable)
    return { id: constraint.id, passed }
  } catch (err) {
    return { id: constraint.id, passed: false, error: (err as Error).message }
  }
}

export function solveAll(formalSpec: FormalSpec, deliverable: unknown): SolveAllResult {
  const failures: Array<{ id: string; error: string }> = []
  let passed = 0
  let hasError = false

  for (const constraint of formalSpec.constraints) {
    try {
      const result = solveConstraint(constraint, deliverable)
      if (result.passed) {
        passed++
      } else {
        failures.push({ id: result.id, error: result.error ?? 'constraint failed' })
      }
    } catch (err) {
      hasError = true
      failures.push({ id: constraint.id, error: (err as Error).message })
    }
  }

  const total = formalSpec.constraints.length
  const result = hasError ? 'error' : (passed === total ? 'pass' : 'fail')

  return { result, constraintsTotal: total, constraintsPassed: passed, failures }
}

// ── Constraint checkers ─────────────────────────────────────────────────────

function checkConstraint(c: Constraint, values: unknown[], root: unknown): boolean {
  switch (c.type) {
    case 'exists': return checkExists(values)
    case 'type': return checkType(values, c.params)
    case 'range': return checkRange(values, c.params)
    case 'length': return checkLength(values, c.params)
    case 'count': return checkCount(values, c.params)
    case 'contains': return checkContains(values, c.params)
    case 'regex': return checkRegex(values, c.params)
    case 'one_of': return checkOneOf(values, c.params)
    case 'format': return checkFormat(values, c.params)
    case 'schema': return checkSchema(values, c.params)
    case 'all': return checkAll(values, c.params, root)
    case 'any': return checkAny(values, c.params, root)
    case 'none': return checkNone(values, c.params, root)
    case 'compare': return checkCompare(values, c.params, root)
    case 'overlap': return checkOverlap(values, c.params, root)
    default: throw new Error(`Unknown constraint type: ${c.type}`)
  }
}

function checkExists(values: unknown[]): boolean {
  return values.length > 0 && values.every(v => v != null)
}

function checkType(values: unknown[], params: Record<string, unknown>): boolean {
  if (values.length === 0) return false
  const expected = params.expected as string
  return values.every(v => {
    if (expected === 'array') return Array.isArray(v)
    if (expected === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v)
    return typeof v === expected
  })
}

function checkRange(values: unknown[], params: Record<string, unknown>): boolean {
  if (values.length === 0) return false
  const min = resolveRangeValue(params.min)
  const max = resolveRangeValue(params.max)

  return values.every(v => {
    const n = toNumeric(v)
    if (n === null) return false
    if (min !== null && n < min) return false
    if (max !== null && n > max) return false
    return true
  })
}

function resolveRangeValue(val: unknown): number | null {
  if (val === undefined || val === null) return null
  if (typeof val === 'number') return val
  if (typeof val === 'string') {
    // Relative offset: "-30d", "+1h", "-7d"
    const match = val.match(/^([+-]?\d+)([dhms])$/)
    if (match) {
      const amount = parseInt(match[1], 10)
      const unit = match[2]
      const ms = { d: 86400000, h: 3600000, m: 60000, s: 1000 }[unit]!
      return Date.now() + amount * ms
    }
    // Try ISO date
    const d = Date.parse(val)
    if (!isNaN(d)) return d
    // Try plain number
    const n = Number(val)
    if (!isNaN(n)) return n
  }
  return null
}

function toNumeric(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const d = Date.parse(v)
    if (!isNaN(d)) return d
    const n = Number(v)
    if (!isNaN(n)) return n
  }
  return null
}

function checkLength(values: unknown[], params: Record<string, unknown>): boolean {
  if (values.length === 0) return false
  const min = params.min as number | undefined
  const max = params.max as number | undefined
  return values.every(v => {
    const len = (typeof v === 'string' || Array.isArray(v)) ? v.length : null
    if (len === null) return false
    if (min !== undefined && len < min) return false
    if (max !== undefined && len > max) return false
    return true
  })
}

function checkCount(values: unknown[], params: Record<string, unknown>): boolean {
  if (values.length === 0) return false
  const min = params.min as number | undefined
  const max = params.max as number | undefined
  return values.every(v => {
    if (!Array.isArray(v)) return false
    if (min !== undefined && v.length < min) return false
    if (max !== undefined && v.length > max) return false
    return true
  })
}

function checkContains(values: unknown[], params: Record<string, unknown>): boolean {
  if (values.length === 0) return false
  const targets = params.values as string[]
  return values.every(v => {
    if (typeof v !== 'string') return false
    return targets.some(t => v.includes(t))
  })
}

function checkRegex(values: unknown[], params: Record<string, unknown>): boolean {
  if (values.length === 0) return false
  const pattern = new RegExp(params.pattern as string)
  return values.every(v => typeof v === 'string' && pattern.test(v))
}

function checkOneOf(values: unknown[], params: Record<string, unknown>): boolean {
  if (values.length === 0) return false
  const allowed = params.values as unknown[]
  return values.every(v => allowed.includes(v))
}

function checkFormat(values: unknown[], params: Record<string, unknown>): boolean {
  if (values.length === 0) return false
  const fmt = params.format as string
  return values.every(v => {
    if (typeof v !== 'string') return false
    switch (fmt) {
      case 'uri': return /^https?:\/\/.+/.test(v)
      case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
      case 'iso8601': return !isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}/.test(v)
      case 'uuid': return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
      default: return false
    }
  })
}

// ── Minimal JSON Schema draft-07 validator ──────────────────────────────────

function checkSchema(values: unknown[], params: Record<string, unknown>): boolean {
  if (values.length === 0) return false
  const schema = params.schema as Record<string, unknown>
  if (!schema) return false
  return values.every(v => validateSchema(v, schema))
}

function validateSchema(value: unknown, schema: Record<string, unknown>): boolean {
  // type
  if (schema.type) {
    const t = schema.type as string
    if (!matchSchemaType(value, t)) return false
  }

  // enum
  if (schema.enum) {
    if (!(schema.enum as unknown[]).includes(value)) return false
  }

  // string constraints
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) return false
    if (schema.maxLength !== undefined && value.length > (schema.maxLength as number)) return false
    if (schema.pattern !== undefined && !new RegExp(schema.pattern as string).test(value)) return false
  }

  // number constraints
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < (schema.minimum as number)) return false
    if (schema.maximum !== undefined && value > (schema.maximum as number)) return false
  }

  // object constraints
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    if (schema.required) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) return false
      }
    }
    if (schema.properties) {
      const props = schema.properties as Record<string, Record<string, unknown>>
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in obj) {
          if (!validateSchema(obj[key], propSchema)) return false
        }
      }
    }
  }

  // array constraints
  if (Array.isArray(value)) {
    if (schema.items) {
      const itemSchema = schema.items as Record<string, unknown>
      for (const item of value) {
        if (!validateSchema(item, itemSchema)) return false
      }
    }
  }

  return true
}

function matchSchemaType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'array': return Array.isArray(value)
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'null': return value === null
    default: return false
  }
}

// ── Nested quantifier types ─────────────────────────────────────────────────

function checkAll(values: unknown[], params: Record<string, unknown>, _root: unknown): boolean {
  // Each value must be an array, every element satisfies nested constraint
  if (values.length === 0) return false
  const nested = params.constraint as Constraint
  return values.every(v => {
    if (!Array.isArray(v)) return false
    return v.every(elem => {
      const r = solveConstraint({ ...nested, target: '$' }, elem)
      return r.passed
    })
  })
}

function checkAny(values: unknown[], params: Record<string, unknown>, _root: unknown): boolean {
  if (values.length === 0) return false
  const nested = params.constraint as Constraint
  return values.every(v => {
    if (!Array.isArray(v)) return false
    return v.some(elem => {
      const r = solveConstraint({ ...nested, target: '$' }, elem)
      return r.passed
    })
  })
}

function checkNone(values: unknown[], params: Record<string, unknown>, _root: unknown): boolean {
  if (values.length === 0) return false
  const nested = params.constraint as Constraint
  return values.every(v => {
    if (!Array.isArray(v)) return false
    return v.every(elem => {
      const r = solveConstraint({ ...nested, target: '$' }, elem)
      return !r.passed
    })
  })
}

// ── Compare ─────────────────────────────────────────────────────────────────

function checkCompare(values: unknown[], params: Record<string, unknown>, root: unknown): boolean {
  if (values.length === 0) return false
  const otherValues = resolveTarget(root, params.other_target as string)
  if (otherValues.length === 0) return false

  const op = params.operator as string

  // Compare first resolved values from each path
  for (const a of values) {
    for (const b of otherValues) {
      const na = toNumeric(a)
      const nb = toNumeric(b)
      if (na === null || nb === null) return false
      if (!compareOp(na, op, nb)) return false
    }
  }
  return true
}

function compareOp(a: number, op: string, b: number): boolean {
  switch (op) {
    case 'gt': return a > b
    case 'gte': return a >= b
    case 'lt': return a < b
    case 'lte': return a <= b
    case 'eq': return a === b
    case 'neq': return a !== b
    default: return false
  }
}

// ── Overlap (LCS ratio) ────────────────────────────────────────────────────

function checkOverlap(values: unknown[], params: Record<string, unknown>, root: unknown): boolean {
  if (values.length === 0) return false
  const otherValues = resolveTarget(root, params.other_target as string)
  if (otherValues.length === 0) return false
  const maxRatio = params.max_ratio as number

  for (const a of values) {
    for (const b of otherValues) {
      if (typeof a !== 'string' || typeof b !== 'string') return false
      // Cap at 10KB
      const sa = a.slice(0, 10240)
      const sb = b.slice(0, 10240)
      const ratio = lcsRatio(sa, sb)
      if (ratio > maxRatio) return false
    }
  }
  return true
}

function lcsRatio(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  const maxLen = Math.max(a.length, b.length)

  // DP — space-optimized (2 rows)
  const m = a.length
  const n = b.length
  let prev = new Uint16Array(n + 1)
  let curr = new Uint16Array(n + 1)

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1])
      }
    }
    ;[prev, curr] = [curr, prev]
    curr.fill(0)
  }

  return prev[n] / maxLen
}
