import type { Context } from 'hono'

/** Success response envelope per §9.4. */
export function success(c: Context, data: unknown, status: number = 200) {
  return c.json(
    {
      data,
      meta: { requestId: crypto.randomUUID() },
    },
    status as 200,
  )
}

/** Error response envelope per §9.4. */
export function error(
  c: Context,
  status: number,
  code: string,
  message: string,
) {
  return c.json(
    {
      error: { code, message },
      meta: { requestId: crypto.randomUUID() },
    },
    status as 400,
  )
}
