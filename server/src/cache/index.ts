// A shared key/value cache with expiry: for site definitions and geo lookups shared between
// instances (Redis), or per process (memory).

export interface Cache {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, ttlMs: number): Promise<void>
}

export function memoryCache(options: { maxEntries?: number; clock?: () => number } = {}): Cache {
  const maxEntries = options.maxEntries ?? 10_000
  const now = options.clock ?? Date.now
  const entries = new Map<string, { value: string; expires: number }>()
  return {
    async get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expires <= now()) {
        entries.delete(key)
        return undefined
      }
      return entry.value
    },
    async set(key, value, ttlMs) {
      entries.delete(key)
      entries.set(key, { value, expires: now() + ttlMs })
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!)
    },
  }
}
