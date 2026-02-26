/**
 * In-memory KV mock for testing rate limiting.
 * Mimics Cloudflare KVNamespace interface.
 */

export function createMockKV(): KVNamespace & { store: Map<string, { value: string; expiration?: number }> } {
  const store = new Map<string, { value: string; expiration?: number }>()

  return {
    store,

    async get(key: string): Promise<string | null> {
      const entry = store.get(key)
      if (!entry) return null
      if (entry.expiration && Date.now() / 1000 > entry.expiration) {
        store.delete(key)
        return null
      }
      return entry.value
    },

    async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number }): Promise<void> {
      const expiration = opts?.expiration ?? (opts?.expirationTtl ? Math.floor(Date.now() / 1000) + opts.expirationTtl : undefined)
      store.set(key, { value, expiration })
    },

    async delete(key: string): Promise<void> {
      store.delete(key)
    },

    async list(): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor: string }> {
      return {
        keys: [...store.keys()].map(name => ({ name })),
        list_complete: true,
        cursor: '',
      }
    },

    async getWithMetadata(): Promise<{ value: string | null; metadata: unknown }> {
      return { value: null, metadata: null }
    },
  } as unknown as KVNamespace & { store: Map<string, { value: string; expiration?: number }> }
}
