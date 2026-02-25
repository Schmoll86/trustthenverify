/**
 * Minimal JSON Schema draft-07 validator for schema_validation method.
 * Supports: type, properties, required, items, enum, minLength, maxLength,
 * minimum, maximum, pattern. No external dependencies.
 */

export function validateSchema(value: unknown, schema: Record<string, unknown>): boolean {
  // type
  if (schema.type) {
    if (!matchType(value, schema.type as string)) return false
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

function matchType(value: unknown, type: string): boolean {
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
