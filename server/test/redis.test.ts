// Redis adapters against a real Redis, with node-redis (@redis/client) and ioredis.
import { randomUUID } from 'node:crypto'

import { createClient } from '@redis/client'
import { Redis as IoRedis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'

import { toFetchHandler } from '../src/http/fetch.ts'
import {
  cachedSites,
  createCollector,
  encodeMessage,
  memoryRateLimiter,
  memoryStore,
  runWorker,
  silentLogger,
  startRetention,
} from '../src/index.ts'
import type { RedisLike } from '../src/redis/index.ts'
import {
  fromIoredis,
  fromNodeRedis,
  fromUpstash,
  redisCache,
  redisLock,
  redisRateLimiter,
  redisStreamQueue,
} from '../src/redis/index.ts'
import { runQueueConformance } from './support/queue-conformance.ts'
import { storedEvent } from './support/store-conformance.ts'

const url = inject('redisUrl')
const ORIGIN = 'https://www.example.com'

describe.skipIf(!url)('Redis', () => {
  let nodeRedis: ReturnType<typeof createClient>
  let ioredis: IoRedis
  const cleanups: Array<() => Promise<unknown>> = []

  beforeAll(async () => {
    nodeRedis = createClient({ url })
    await nodeRedis.connect()
    ioredis = new IoRedis(url, { lazyConnect: true })
    await ioredis.connect()
  })
  afterAll(async () => {
    for (const cleanup of cleanups) await cleanup()
    await nodeRedis.quit()
    ioredis.disconnect()
  })

  const clients: Array<[string, () => RedisLike]> = [
    ['node-redis', () => fromNodeRedis(nodeRedis as never)],
    ['ioredis', () => fromIoredis(ioredis as never)],
  ]

  describe.each(clients)('%s', (_name, redisFor) => {
    runQueueConformance('redisStreamQueue', async () => {
      const queue = redisStreamQueue(redisFor(), {
        stream: `{test-${randomUUID()}}:ingest`,
        visibilityTimeoutMs: 500,
      })
      return {
        queue,
        visibilityTimeoutMs: 500,
        async deadLetters() {
          const entries = (await redisFor().command!([
            'XRANGE',
            queue.keys.dead,
            '-',
            '+',
          ])) as Array<[string, string[]]>
          return entries.map(([, fields]) => fields[fields.indexOf('body') + 1]!)
        },
        cleanup: () => queue.close!(),
      }
    })

    it('cache: values round-trip, expire, and never collide with other keys', async () => {
      const cache = redisCache(redisFor(), { prefix: `{test-${randomUUID()}}:` })
      expect(await cache.get('missing')).toBeUndefined()
      await cache.set('site', '{"siteKey":"a"}', 10_000)
      await cache.set('null', 'null', 10_000)
      expect(await cache.get('site')).toBe('{"siteKey":"a"}')
      expect(await cache.get('null')).toBe('null')
      await cache.set('short', 'x', 50)
      await new Promise(r => setTimeout(r, 120))
      expect(await cache.get('short')).toBeUndefined()
    })

    it('lock: one holder at a time; released by its holder; expires after ttl', async () => {
      const lock = redisLock(redisFor(), { prefix: `{test-${randomUUID()}}:` })
      const release = await lock.acquire('job', 10_000)
      expect(release).toBeTypeOf('function')
      expect(await lock.acquire('job', 10_000)).toBeNull()
      await release!()
      const again = await lock.acquire('job', 100)
      expect(again).toBeTypeOf('function')
      await new Promise(r => setTimeout(r, 200)) // expired: someone else may take it
      const other = await lock.acquire('job', 10_000)
      expect(other).toBeTypeOf('function')
      await again!() // a stale holder cannot release someone else's lock
      expect(await lock.acquire('job', 10_000)).toBeNull()
      await other!()
    })

    it('rate limits are shared by every instance on the same Redis', async () => {
      const prefix = `{test-${randomUUID()}}:`
      const collector = () =>
        toFetchHandler(
          createCollector({
            sites: [{ siteKey: 'my-site', allowedOrigins: [ORIGIN] }],
            store: memoryStore(),
            logger: false,
            rateLimit: {
              limiter: redisRateLimiter(redisFor(), { prefix }),
              perIp: { limit: 3, windowMs: 60_000 },
            },
          }),
          { getClientIp: () => '203.0.113.9' },
        )
      const [a, b] = [collector(), collector()]
      const get = (handle: typeof a) =>
        handle(new Request('http://collector.test/v1/context?siteKey=my-site'))
      expect((await get(a)).status).toBe(200)
      expect((await get(b)).status).toBe(200)
      expect((await get(a)).status).toBe(200)
      const limited = await get(b)
      expect(limited.status).toBe(429)
      expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
      expect(((await limited.json()) as { title: string }).title).toBe('Too many requests')
      // No raw IP address in Redis keys.
      const keys = (await redisFor().command!(['KEYS', `${prefix}*`])) as string[]
      expect(keys.join()).not.toContain('203.0.113')
    })

    it('shared site cache: a second instance gets the site from Redis, not the source', async () => {
      const shared = redisCache(redisFor(), { prefix: `{test-${randomUUID()}}:` })
      const getSite = vi.fn(async (siteKey: string) => ({
        siteKey,
        allowedOrigins: [ORIGIN],
        policyVersion: '1',
        consentMode: 'geo' as const,
        trackingWithoutConsent: 'limited' as const,
      }))
      const source = { getSite, isOriginAllowed: async () => true }
      await cachedSites(source, { shared }).getSite('my-site')
      expect(await cachedSites(source, { shared }).getSite('my-site')).toMatchObject({
        siteKey: 'my-site',
      })
      expect(getSite).toHaveBeenCalledOnce()
    })

    it('the worker reclaims messages from a crashed consumer', async () => {
      const stream = `{test-${randomUUID()}}:ingest`
      const crashed = redisStreamQueue(redisFor(), {
        stream,
        consumer: 'crashed',
        visibilityTimeoutMs: 300,
      })
      const healthy = redisStreamQueue(redisFor(), {
        stream,
        consumer: 'healthy',
        visibilityTimeoutMs: 300,
      })
      await crashed.send([
        encodeMessage({
          kind: 'events',
          v: 1,
          requestId: 'r',
          siteKey: 'site-a',
          events: [storedEvent()],
        }),
      ])
      expect(await crashed.receive({ max: 10, waitMs: 1_000 })).toHaveLength(1) // and never acked
      const store = memoryStore()
      const worker = runWorker({ queue: healthy, store, waitMs: 200, logger: false })
      await vi.waitFor(async () => expect(await store.listEvents()).toHaveLength(1), {
        timeout: 10_000,
      })
      await worker.stop()
      await Promise.all([crashed.close!(), healthy.close!()])
    })

    it('retention jobs on several instances: one purge at a time', async () => {
      const lock = redisLock(redisFor(), { prefix: `{test-${randomUUID()}}:` })
      const store = memoryStore()
      let running = 0
      let overlapped = false
      const purge = store.purge
      store.purge = async options => {
        if (++running > 1) overlapped = true
        await new Promise(r => setTimeout(r, 100))
        running--
        return purge(options)
      }
      const jobs = [1, 2, 3].map(() =>
        startRetention({ store, lock, logger: false, runAtStart: false }),
      )
      const results = await Promise.all(jobs.map(job => job.runNow()))
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(overlapped).toBe(false)
      await Promise.all(jobs.map(job => job.stop()))
    })
  })

  describe('failures', () => {
    const broken: RedisLike = {
      eval: async () => {
        throw new Error('redis down')
      },
    }

    it('the rate limiter falls back to per-instance limits while Redis fails', async () => {
      const onError = vi.fn()
      const limiter = redisRateLimiter(broken, { fallback: memoryRateLimiter(), onError })
      expect((await limiter.consume('k', 1, 1_000)).allowed).toBe(true)
      expect((await limiter.consume('k', 1, 1_000)).allowed).toBe(false)
      expect(onError).toHaveBeenCalledTimes(2)
    })

    it('without a fallback the collector allows by default, or answers 503 with onError: reject', async () => {
      const handle = (onError?: 'allow' | 'reject') =>
        toFetchHandler(
          createCollector({
            sites: [{ siteKey: 'my-site', allowedOrigins: [ORIGIN] }],
            store: memoryStore(),
            logger: silentLogger,
            rateLimit: {
              limiter: redisRateLimiter(broken),
              perSite: { limit: 1, windowMs: 1_000 },
              ...(onError ? { onError } : {}),
            },
          }),
        )(new Request('http://collector.test/v1/context?siteKey=my-site'))
      expect((await handle()).status).toBe(200)
      expect((await handle('reject')).status).toBe(503)
    })

    it('the Streams queue needs a TCP client', () => {
      expect(() => redisStreamQueue(fromUpstash({ eval: async () => null }))).toThrow(
        /TCP Redis client/,
      )
    })
  })

  describe('@upstash/redis wrapper', () => {
    // Upstash's HTTP client decodes JSON results automatically; this stand-in does the same,
    // running scripts on the real Redis.
    const upstashLike = {
      async eval(script: string, keys: string[], args: unknown[]) {
        const result = await ioredis.eval(script, keys.length, ...keys, ...(args as string[]))
        if (typeof result === 'string') {
          try {
            return JSON.parse(result)
          } catch {
            return result
          }
        }
        return result
      },
    }

    it('cache (values survive automatic JSON decoding), lock and rate limiter work', async () => {
      const redis = fromUpstash(upstashLike)
      const prefix = `{test-${randomUUID()}}:`
      const cache = redisCache(redis, { prefix })
      await cache.set('k', '{"a":1}', 10_000)
      await cache.set('n', '42', 10_000)
      expect(await cache.get('k')).toBe('{"a":1}')
      expect(await cache.get('n')).toBe('42')
      const release = await redisLock(redis, { prefix }).acquire('job', 10_000)
      expect(release).toBeTypeOf('function')
      await release!()
      const limiter = redisRateLimiter(redis, { prefix })
      expect((await limiter.consume('ip', 1, 60_000)).allowed).toBe(true)
      expect((await limiter.consume('ip', 1, 60_000)).allowed).toBe(false)
    })
  })
})
