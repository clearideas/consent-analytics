// Redis: shared rate limits, caches and locks for several collector instances, and a Redis
// Streams queue between the API and workers. Bring your own client:
//
//   import { createClient } from 'redis'            // or @redis/client
//   const redis = fromNodeRedis(await createClient({ url }).connect())
//   // ioredis:        fromIoredis(new Redis(url))
//   // @upstash/redis: fromUpstash(Redis.fromEnv())  (caches, locks and rate limits only)
//
// Rate limits, caches and locks are single Lua scripts (atomic; `eval` only). The Streams queue
// also needs raw commands and blocking reads, so it works with TCP clients (node-redis,
// ioredis), not Upstash's HTTP client.
//
// Keys share a hash tag (`{consent-analytics}` by default), so scripts work on Redis Cluster.
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import type { Cache } from '../cache/index.ts'
import type { IngestQueue, ReceivedMessage } from '../delivery/queue.ts'
import type { RateLimiter } from '../ratelimit/index.ts'
import type { Lock } from '../retention/index.ts'

export interface RedisLike {
  /** Run a Lua script. */
  eval(
    script: string,
    keys: readonly string[],
    args: ReadonlyArray<string | number>,
  ): Promise<unknown>
  /** Any command (TCP clients). */
  command?(args: ReadonlyArray<string | number>): Promise<unknown>
  /** A second connection of the same client (for blocking reads). */
  duplicate?(): Promise<RedisLike & { close(): Promise<void> }>
}

// --- client wrappers ----------------------------------------------------------------------

/** What is used of a node-redis (`redis`, `@redis/client`) client. */
export interface NodeRedisClientLike {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
  sendCommand(args: string[]): Promise<unknown>
  duplicate(): {
    connect(): Promise<unknown>
    close?(): Promise<unknown>
    quit?(): Promise<unknown>
  } & NodeRedisClientLike
}

/** node-redis v4 to v6 (`redis`, `@redis/client`). The client must be connected. */
export function fromNodeRedis(client: NodeRedisClientLike): RedisLike {
  return {
    eval: (script, keys, args) =>
      client.eval(script, { keys: [...keys], arguments: args.map(String) }),
    command: args => client.sendCommand(args.map(String)),
    async duplicate() {
      const copy = client.duplicate()
      await copy.connect()
      return {
        ...fromNodeRedis(copy),
        close: async () => {
          await (copy.close ? copy.close() : copy.quit?.())
        },
      }
    },
  }
}

/** What is used of an ioredis client. */
export interface IoredisClientLike {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
  call(command: string, ...args: Array<string | number>): Promise<unknown>
  duplicate(): IoredisClientLike & { quit(): Promise<unknown> }
}

export function fromIoredis(client: IoredisClientLike): RedisLike {
  return {
    eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args),
    command: ([command, ...args]) => client.call(String(command), ...args),
    async duplicate() {
      const copy = client.duplicate()
      return {
        ...fromIoredis(copy),
        close: async () => {
          await copy.quit()
        },
      }
    },
  }
}

/** What is used of an @upstash/redis client. */
export interface UpstashClientLike {
  eval(script: string, keys: string[], args: unknown[]): Promise<unknown>
}

/** @upstash/redis (HTTP): rate limits, caches and locks; not the Streams queue. */
export function fromUpstash(client: UpstashClientLike): RedisLike {
  return { eval: (script, keys, args) => client.eval(script, [...keys], [...args].map(String)) }
}

// --- rate limiter ---------------------------------------------------------------------------

const RATE_LIMIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`

export interface RedisRateLimiterOptions {
  prefix?: string
  /** Used while Redis fails (then limits are per instance). Default: none, errors propagate. */
  fallback?: RateLimiter
  onError?(error: unknown): void
}

/** Fixed-window limits shared by every instance using the same Redis. */
export function redisRateLimiter(
  redis: RedisLike,
  options: RedisRateLimiterOptions = {},
): RateLimiter {
  const prefix = options.prefix ?? '{consent-analytics}:rl:'
  return {
    async consume(key, limit, windowMs) {
      try {
        const [count, ttl] = (await redis.eval(RATE_LIMIT, [prefix + key], [windowMs])) as [
          number,
          number,
        ]
        const used = Number(count)
        return {
          allowed: used <= limit,
          remaining: Math.max(limit - used, 0),
          retryAfterMs: used <= limit ? 0 : Math.max(Number(ttl), 0),
        }
      } catch (error) {
        if (!options.fallback) throw error
        options.onError?.(error)
        return options.fallback.consume(key, limit, windowMs)
      }
    },
  }
}

// --- cache --------------------------------------------------------------------------------

const CACHE_GET = `return redis.call('GET', KEYS[1])`
const CACHE_SET = `redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1`
// Values are stored with a marker so no client can mistake them for JSON to decode.
const MARK = 'ca1:'

export function redisCache(redis: RedisLike, options: { prefix?: string } = {}): Cache {
  const prefix = options.prefix ?? '{consent-analytics}:cache:'
  return {
    async get(key) {
      const value = await redis.eval(CACHE_GET, [prefix + key], [])
      return typeof value === 'string' && value.startsWith(MARK)
        ? value.slice(MARK.length)
        : undefined
    },
    async set(key, value, ttlMs) {
      await redis.eval(CACHE_SET, [prefix + key], [MARK + value, Math.max(1, Math.round(ttlMs))])
    },
  }
}

// --- lock -----------------------------------------------------------------------------------

const LOCK_ACQUIRE = `return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])`
const LOCK_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`

/** A lock held by one process at a time (released by its holder, or after ttlMs). */
export function redisLock(redis: RedisLike, options: { prefix?: string } = {}): Lock {
  const prefix = options.prefix ?? '{consent-analytics}:lock:'
  return {
    async acquire(name, ttlMs) {
      const token = randomUUID()
      const result = await redis.eval(
        LOCK_ACQUIRE,
        [prefix + name],
        [token, Math.max(1, Math.round(ttlMs))],
      )
      if (result !== 'OK') return null
      return async () => {
        await redis.eval(LOCK_RELEASE, [prefix + name], [token])
      }
    },
  }
}

// --- Streams queue --------------------------------------------------------------------------

// Move due delayed messages ("attempts|id|body", scored by due time) back into the stream.
const PROMOTE = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
for _, member in ipairs(due) do
  redis.call('ZREM', KEYS[1], member)
  local first = string.find(member, '|', 1, true)
  local second = string.find(member, '|', first + 1, true)
  redis.call('XADD', KEYS[2], '*', 'body', string.sub(member, second + 1), 'attempts', string.sub(member, 1, first - 1))
end
return #due`

export interface RedisStreamQueueOptions {
  /** Stream key. Default "{consent-analytics}:ingest" (keys with the same {tag} share a slot). */
  stream?: string
  /** Consumer group. Default "workers". */
  group?: string
  /** This process's consumer name. Default hostname-pid-random. */
  consumer?: string
  /** A received message not acked within this time is delivered again. Default 60 s. */
  visibilityTimeoutMs?: number
  /** Dead-letter stream. Default `${stream}:dead`. */
  deadLetterStream?: string
}

export type RedisStreamQueue = IngestQueue & {
  readonly keys: { stream: string; delayed: string; dead: string }
}

type Fields = string[]

/**
 * The entries of an XREADGROUP reply for one stream. Clients decode it differently:
 * RESP2 `[[stream, entries]]` (classic), an object `{ stream: entries }` (node-redis), or a
 * flattened map `[stream, entries]` (ioredis with RESP3).
 */
function streamEntries(reply: unknown): Array<[string, unknown]> {
  if (!reply) return []
  if (!Array.isArray(reply))
    return (Object.values(reply as object)[0] as Array<[string, unknown]>) ?? []
  if (typeof reply[0] === 'string') return (reply[1] as Array<[string, unknown]>) ?? []
  return ((reply[0] as [string, Array<[string, unknown]>])?.[1] ?? []) as Array<[string, unknown]>
}

const fieldsOf = (raw: unknown): Record<string, string> => {
  const fields = (raw ?? []) as Fields
  const out: Record<string, string> = {}
  for (let i = 0; i + 1 < fields.length; i += 2) out[String(fields[i])] = String(fields[i + 1])
  return out
}

/**
 * An IngestQueue on Redis Streams with a consumer group: at-least-once delivery, messages of
 * crashed workers reclaimed after `visibilityTimeoutMs` (XAUTOCLAIM), delayed retries through a
 * sorted set, dead letters in their own stream. Acked entries are deleted, so the stream only
 * holds what is waiting.
 */
export function redisStreamQueue(
  redis: RedisLike,
  options: RedisStreamQueueOptions = {},
): RedisStreamQueue {
  if (!redis.command)
    throw new Error('redisStreamQueue needs a TCP Redis client (node-redis or ioredis)')
  const command = redis.command.bind(redis)
  const stream = options.stream ?? '{consent-analytics}:ingest'
  const keys = {
    stream,
    delayed: `${stream}:delayed`,
    dead: options.deadLetterStream ?? `${stream}:dead`,
  }
  const group = options.group ?? 'workers'
  const consumer = options.consumer ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
  const visibilityTimeoutMs = options.visibilityTimeoutMs ?? 60_000
  const idle: Array<RedisLike & { close(): Promise<void> }> = []
  const all: Array<RedisLike & { close(): Promise<void> }> = []
  let groupReady: Promise<void> | undefined

  const ensureGroup = () =>
    (groupReady ??= command(['XGROUP', 'CREATE', stream, group, '0', 'MKSTREAM']).then(
      () => undefined,
      error => {
        if (!String((error as Error)?.message).includes('BUSYGROUP')) {
          groupReady = undefined
          throw error
        }
      },
    ))

  /** A blocking connection per concurrent receive (blocking reads hold their connection). */
  const blocking = async () => {
    const existing = idle.pop()
    if (existing) return existing
    if (!redis.duplicate)
      throw new Error('redisStreamQueue needs a client that can duplicate its connection')
    const connection = await redis.duplicate()
    all.push(connection)
    return connection
  }

  const toMessage = (id: string, raw: unknown, deliveries: number): ReceivedMessage => {
    const fields = fieldsOf(raw)
    return {
      body: fields.body ?? '',
      attempts: Number(fields.attempts ?? 0) + deliveries,
      handle: { id },
    }
  }

  const remove = async (ids: string[]) => {
    if (!ids.length) return
    await command(['XACK', stream, group, ...ids])
    await command(['XDEL', stream, ...ids])
  }

  return {
    keys,

    async send(bodies) {
      for (const body of bodies) await command(['XADD', stream, '*', 'body', body, 'attempts', 0])
    },

    async receive({ max, waitMs, signal }) {
      await ensureGroup()
      await redis.eval(PROMOTE, [keys.delayed, stream], [Date.now(), max])

      // Messages of crashed (or slow) consumers first.
      const claimed = (await command([
        'XAUTOCLAIM',
        stream,
        group,
        consumer,
        visibilityTimeoutMs,
        '0-0',
        'COUNT',
        max,
      ])) as [string, Array<[string, unknown] | null>]
      const entries = (claimed?.[1] ?? []).filter((entry): entry is [string, unknown] => !!entry)
      if (entries.length) {
        return Promise.all(
          entries.map(async ([id, raw]) => {
            const pending = (await command(['XPENDING', stream, group, id, id, 1])) as Array<
              [string, string, number, number]
            >
            return toMessage(id, raw, Number(pending?.[0]?.[3] ?? 1))
          }),
        )
      }

      // New messages: block in short slices so an abort or the deadline is noticed.
      const deadline = Date.now() + waitMs
      const connection = await blocking()
      try {
        do {
          const block = Math.max(1, Math.min(deadline - Date.now(), 1_000))
          const read = streamEntries(
            await connection.command!([
              'XREADGROUP',
              'GROUP',
              group,
              consumer,
              'COUNT',
              max,
              'BLOCK',
              block,
              'STREAMS',
              stream,
              '>',
            ]),
          )
          if (read.length) return read.map(([id, raw]) => toMessage(id, raw, 1))
          if (signal?.aborted) return []
          await redis.eval(PROMOTE, [keys.delayed, stream], [Date.now(), max])
        } while (Date.now() < deadline)
        return []
      } finally {
        idle.push(connection)
      }
    },

    async ack(messages) {
      await remove(messages.map(message => (message.handle as { id: string }).id))
    },

    async retry(message, delayMs) {
      const member = `${message.attempts}|${randomUUID()}|${message.body}`
      await command(['ZADD', keys.delayed, Date.now() + delayMs, member])
      await remove([(message.handle as { id: string }).id])
    },

    async deadLetter(message, reason) {
      await command([
        'XADD',
        keys.dead,
        '*',
        'body',
        message.body,
        'reason',
        reason,
        'attempts',
        message.attempts,
      ])
      await remove([(message.handle as { id: string }).id])
    },

    async close() {
      await Promise.all(all.splice(0).map(connection => connection.close().catch(() => {})))
      idle.length = 0
    },
  }
}
