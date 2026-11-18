// Rate limiting: fixed windows of `windowMs`, at most `limit` requests per key and window.
// The in-memory limiter is per process; use the Redis limiter to share limits between
// instances.

export interface RateLimitResult {
  allowed: boolean
  /** Requests left in the current window. */
  remaining: number
  /** When allowed is false: how long until the window resets. */
  retryAfterMs: number
}

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>
}

export interface RateLimitRule {
  limit: number
  windowMs: number
}

export interface MemoryRateLimiterOptions {
  /** Most keys tracked (oldest windows dropped first). Default 100 000. */
  maxKeys?: number
  clock?: () => number
}

export function memoryRateLimiter(options: MemoryRateLimiterOptions = {}): RateLimiter {
  const maxKeys = options.maxKeys ?? 100_000
  const now = options.clock ?? Date.now
  const windows = new Map<string, { count: number; resetAt: number }>()
  return {
    async consume(key, limit, windowMs) {
      const time = now()
      let window = windows.get(key)
      if (!window || window.resetAt <= time) {
        windows.delete(key)
        window = { count: 0, resetAt: time + windowMs }
        windows.set(key, window)
        while (windows.size > maxKeys) windows.delete(windows.keys().next().value!)
      }
      window.count++
      const allowed = window.count <= limit
      return {
        allowed,
        remaining: Math.max(limit - window.count, 0),
        retryAfterMs: allowed ? 0 : window.resetAt - time,
      }
    },
  }
}
