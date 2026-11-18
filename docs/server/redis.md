---
title: Redis and rate limits
description: 'Use Redis (node-redis, ioredis or Upstash) for shared rate limits, caches, the retention lock and a Redis Streams queue; configure rate limits.'
---

# Redis and rate limits

## Redis

`/redis` works with **node-redis** (`redis` or `@redis/client`), **ioredis**, and, for
everything except the queue, **Upstash**'s HTTP client. Wrap your client once:

```ts
import { createClient } from '@redis/client'
import { fromNodeRedis } from '@clearideas/consent-analytics-server/redis'

const client = await createClient({ url: process.env.REDIS_URL }).connect()
const redis = fromNodeRedis(client)
// or fromIoredis(new Redis(process.env.REDIS_URL)),
// or fromUpstash(Redis.fromEnv())
```

Your client stays yours: connect it before use, and close it on shutdown.

| Function | What it's for |
| --- | --- |
| `redisRateLimiter(redis, { fallback?, prefix?, onError? })` | [Rate limits](#rate-limits) shared by every instance: fixed windows, one round trip per check. With `fallback: memoryRateLimiter()`, limits become per instance while Redis is down, instead of failing. |
| `redisCache(redis, { prefix? })` | A cache shared by instances: `cachedSites(source, { shared: cache })` and `ipinfoGeo({ cache })`, so site lookups and location answers are shared. |
| `redisLock(redis, { prefix? })` | The [retention job's](./retention-and-privacy.md) lock, so one purge runs at a time (`SET NX PX`; released only by its owner). |
| `redisStreamQueue(redis, options)` | A [queue](./delivery.md#redis-streams) on a Redis Stream. Needs node-redis or ioredis. |

Keys start with `{consent-analytics}:`, so on Redis Cluster related keys share a slot.
Change it with `prefix` (for example to separate environments sharing one Redis).

Tested against Redis 7 with node-redis 6 and ioredis 6 (the queue passes the same
conformance tests as every queue), and Upstash through a fake of its HTTP API.

### The Redis Streams queue

```ts
const queue = redisStreamQueue(redis, {
  stream: '{consent-analytics}:ingest', // default
  group: 'workers',                     // consumer group, default
  visibilityTimeoutMs: 60_000,          // default
})
```

| Option | Default | |
| --- | --- | --- |
| `stream` | `{consent-analytics}:ingest` | The stream key |
| `group` | `workers` | The consumer group |
| `consumer` | host, process ID and a random part | This process's consumer name |
| `visibilityTimeoutMs` | 60 000 | A message received but not acknowledged within this time is delivered again (to any worker) |
| `deadLetterStream` | `<stream>:dead` | Where dead letters go |

- Delayed retries wait in a sorted set and are moved back to the stream when due.
- Acknowledged entries are deleted: the stream holds only what's waiting.
- Each receive loop of the worker uses its own duplicate connection for blocking reads, so
  your other Redis commands are never delayed.
- Use Redis persistence (AOF) if queued messages must survive a Redis restart.

## Rate limits

```ts
import { memoryRateLimiter } from '@clearideas/consent-analytics-server'
import { redisRateLimiter } from '@clearideas/consent-analytics-server/redis'

createCollector({
  rateLimit: {
    // or memoryRateLimiter()
    limiter: redisRateLimiter(redis, { fallback: memoryRateLimiter() }),
    perIp: { limit: 600, windowMs: 60_000 },
    perSite: { limit: 100_000, windowMs: 60_000 },
    onError: 'allow', // default; or 'reject' (503)
  },
  ...
})
```

- **`perIp`** is checked for every request except `/v1/health` and preflights, before the
  body is read (only when the client IP is known); **`perSite`** once the site is known.
- Over the limit, the collector answers `429` with `Retry-After`.
- If the limiter itself fails, requests are allowed (`onError: 'allow'`, logged and reported
  to `hooks.onError`), or refused with `503` (`'reject'`).
- Rate-limit keys never contain an IP address: an HMAC with `hashSecret`, or a hash without
  one.
- `perIp` needs the real client address: set [`trustProxy`](./node-and-fetch.md#client-ip)
  (or Express's `trust proxy`) behind proxies, or every visitor shares the proxy's limit.
- `memoryRateLimiter()` counts per process: with several instances, each allows the full
  limit.

**Choose generous limits.** Browsers send most batches with `sendBeacon`, which can't see
the answer: events refused with `429` are lost, not retried. A visitor produces a few
requests per page (context, events, consent); offices and mobile carriers put many visitors
behind one IP address. Limits are a protection against abuse, not a quota.

## Caches

The `Cache` interface is small, so you can use another shared cache too:

```ts
interface Cache {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, ttlMs: number): Promise<void>
}
```

`memoryCache()` is the in-process one. Shared-cache failures are ignored: the collector
falls back to its own memory and the source.
