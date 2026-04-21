/**
 * In-memory mock SupabaseClient for testing.
 * Supports basic from().select/insert/update/eq/in/single/or/contains/order/limit chains.
 */

interface Row {
  [key: string]: unknown
}

interface TableStore {
  rows: Row[]
}

export function createMockDb() {
  const tables: Record<string, TableStore> = {}

  function getTable(name: string): TableStore {
    if (!tables[name]) {
      tables[name] = { rows: [] }
    }
    return tables[name]
  }

  function seedTable(name: string, rows: Row[]) {
    tables[name] = { rows: [...rows] }
  }

  function clearAll() {
    for (const key of Object.keys(tables)) {
      delete tables[key]
    }
  }

  function from(tableName: string) {
    const table = getTable(tableName)
    let filteredRows = [...table.rows]
    let selectFields: string | null = null
    let insertData: Row | null = null
    let updateData: Row | null = null
    let isSingle = false
    let orderField: string | null = null
    let orderAsc = true
    let limitCount: number | null = null
    let doSelect = false
    // Track eq filters for update
    const eqFilters: Array<{ field: string; value: unknown }> = []

    const chain = {
      select(fields: string = '*') {
        selectFields = fields
        doSelect = true
        return chain
      },
      insert(data: Row | Row[]) {
        const row = Array.isArray(data) ? data[0] : data
        insertData = {
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          ...row,
        }
        table.rows.push(insertData)
        filteredRows = [insertData]
        return chain
      },
      update(data: Row) {
        updateData = data
        return chain
      },
      delete() {
        // Mark for deletion — applied in then()
        return {
          eq(field: string, value: unknown) {
            const before = table.rows.length
            table.rows = table.rows.filter((r) => r[field] !== value)
            return Promise.resolve({ data: null, error: null, count: before - table.rows.length })
          },
        }
      },
      eq(field: string, value: unknown) {
        eqFilters.push({ field, value })
        filteredRows = filteredRows.filter((r) => r[field] === value)
        return chain
      },
      in(field: string, values: unknown[]) {
        filteredRows = filteredRows.filter((r) => values.includes(r[field]))
        return chain
      },
      lt(field: string, value: unknown) {
        filteredRows = filteredRows.filter((r) => {
          const rVal = r[field]
          if (typeof rVal === 'string' && typeof value === 'string') {
            return rVal < value
          }
          return (rVal as number) < (value as number)
        })
        return chain
      },
      gte(field: string, value: unknown) {
        filteredRows = filteredRows.filter((r) => {
          const rVal = r[field]
          if (typeof rVal === 'string' && typeof value === 'string') {
            return rVal >= value
          }
          return (rVal as number) >= (value as number)
        })
        return chain
      },
      contains(field: string, jsonStr: string) {
        const arr = JSON.parse(jsonStr)
        filteredRows = filteredRows.filter((r) => {
          const val = r[field]
          if (Array.isArray(val) && Array.isArray(arr)) {
            return arr.every((item: unknown) =>
              (val as unknown[]).includes(item)
            )
          }
          return false
        })
        return chain
      },
      or(filterStr: string) {
        // Simple OR: handle capabilities.cs.["x"] patterns
        const parts = filterStr.split(',')
        const matchers = parts.map((part) => {
          const csMatch = part.match(/^(\w+)\.cs\.(.+)$/)
          if (csMatch) {
            const [, field, jsonStr] = csMatch
            const arr = JSON.parse(jsonStr)
            return (r: Row) => {
              const val = r[field]
              if (Array.isArray(val) && Array.isArray(arr)) {
                return arr.every((item: unknown) => (val as unknown[]).includes(item))
              }
              return false
            }
          }
          const ilikeMatch = part.match(/^(\w+)\.ilike\.(.+)$/)
          if (ilikeMatch) {
            const [, field, pattern] = ilikeMatch
            const regexStr = '^' + pattern.replace(/%/g, '.*') + '$'
            const regex = new RegExp(regexStr, 'i')
            return (r: Row) => regex.test(String(r[field] ?? ''))
          }
          const eqMatch = part.match(/^(\w+)\.eq\.(.+)$/)
          if (eqMatch) {
            const [, field, value] = eqMatch
            return (r: Row) => String(r[field]) === value
          }
          return () => true
        })
        filteredRows = filteredRows.filter((r) => matchers.some((m) => m(r)))
        return chain
      },
      order(field: string, opts?: { ascending?: boolean }) {
        orderField = field
        orderAsc = opts?.ascending ?? true
        return chain
      },
      limit(count: number) {
        limitCount = count
        return chain
      },
      single() {
        isSingle = true
        return chain.then()
      },
      then(resolve?: (value: { data: Row | Row[] | null; error: null }) => void) {
        // Apply update if pending
        if (updateData) {
          for (const row of table.rows) {
            const matches = eqFilters.every((f) => row[f.field] === f.value)
            if (matches) {
              Object.assign(row, updateData)
            }
          }
          // Re-filter to return updated rows
          filteredRows = table.rows.filter((row) =>
            eqFilters.every((f) => row[f.field] === f.value)
          )
        }

        if (orderField) {
          filteredRows.sort((a, b) => {
            const aVal = String(a[orderField!] ?? '')
            const bVal = String(b[orderField!] ?? '')
            return orderAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
          })
        }
        if (limitCount) {
          filteredRows = filteredRows.slice(0, limitCount)
        }

        const result = isSingle
          ? { data: filteredRows[0] ?? null, error: null }
          : { data: filteredRows, error: null }

        if (resolve) {
          resolve(result)
          return undefined as unknown
        }
        return Promise.resolve(result)
      },
    }

    // Make chain thenable
    ;(chain as unknown as { [Symbol.toStringTag]: string })[Symbol.toStringTag] = 'Promise'

    return chain
  }

  return {
    from,
    seedTable,
    clearAll,
    getTable,
  }
}

export type MockDb = ReturnType<typeof createMockDb>
