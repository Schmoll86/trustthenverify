/**
 * Minimal JSONPath-subset resolver per SPEC-v2 §3.1.
 * Supports: $, .field, [*] (fan out), [index].
 * No external dependencies.
 */

export function resolveTarget(root: unknown, targetPath: string): unknown[] {
  if (!targetPath.startsWith('$')) return []

  const tokens = tokenize(targetPath.slice(1)) // strip leading $
  let current: unknown[] = [root]

  for (const token of tokens) {
    const next: unknown[] = []
    for (const val of current) {
      if (token.type === 'field') {
        if (val != null && typeof val === 'object') {
          const v = (val as Record<string, unknown>)[token.name]
          if (v !== undefined) next.push(v)
        }
      } else if (token.type === 'wildcard') {
        if (Array.isArray(val)) {
          next.push(...val)
        }
        // [*] on non-array → empty
      } else if (token.type === 'index') {
        if (Array.isArray(val) && token.index >= 0 && token.index < val.length) {
          next.push(val[token.index])
        }
      }
    }
    current = next
    if (current.length === 0) return []
  }

  return current
}

type Token =
  | { type: 'field'; name: string }
  | { type: 'wildcard' }
  | { type: 'index'; index: number }

function tokenize(path: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < path.length) {
    if (path[i] === '.') {
      i++
      const start = i
      while (i < path.length && path[i] !== '.' && path[i] !== '[') i++
      if (i > start) tokens.push({ type: 'field', name: path.slice(start, i) })
    } else if (path[i] === '[') {
      i++
      if (path[i] === '*') {
        tokens.push({ type: 'wildcard' })
        i += 2 // skip *]
      } else {
        const start = i
        while (i < path.length && path[i] !== ']') i++
        const idx = parseInt(path.slice(start, i), 10)
        tokens.push({ type: 'index', index: idx })
        i++ // skip ]
      }
    } else {
      i++
    }
  }
  return tokens
}
