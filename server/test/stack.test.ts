// The whole library in one deployment, as in the README's "A complete Express API": an
// Express 5 API with optional cookie authentication, Mongoose (store and sites), node-redis
// (rate limits, shared caches, retention lock), SQS for events (worker in another "process")
// and IPinfo for location. Real services (see test/support/services.ts); IPinfo is faked.
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import * as sqs from '@aws-sdk/client-sqs'
import { createClient } from '@redis/client'
import express from 'express'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'

import { ipinfoGeo } from '../src/geo/ipinfo.ts'
import { collectorMiddleware } from '../src/http/express.ts'
import type { Collector, Worker } from '../src/index.ts'
import {
  balancedDataPolicy,
  cachedSites,
  chainGeo,
  createCollector,
  memoryRateLimiter,
  runWorker,
  startRetention,
  trustedHeaderGeo,
} from '../src/index.ts'
import { sqsQueue } from '../src/queues/sqs.ts'
import { fromNodeRedis, redisCache, redisLock, redisRateLimiter } from '../src/redis/index.ts'
import { ensureMongoIndexes, mongoSites, mongoStore } from '../src/stores/mongodb.ts'

const mongoUrl = inject('mongodbUrl')
const redisUrl = inject('redisUrl')
const awsEndpoint = inject('awsEndpoint')

const SITE = 'https://www.example.test'
const json = (response: Response) => response.json() as Promise<any>
const HASH_SECRET = 'a-long-random-test-secret'
// IPinfo stand-in: a German, a Californian and a Japanese address.
const IPINFO: Record<string, Record<string, string>> = {
  '81.2.69.142': {
    ip: '81.2.69.142',
    country: 'DE',
    region: 'Berlin',
    city: 'Berlin',
    loc: '52.52,13.40',
    org: 'AS3320 Deutsche Telekom AG',
  },
  '8.8.4.4': {
    ip: '8.8.4.4',
    country: 'US',
    region: 'California',
    city: 'Mountain View',
    loc: '37.38,-122.08',
    org: 'AS15169 Google LLC',
  },
  '1.1.1.9': { ip: '1.1.1.9', country: 'JP', city: 'Tokyo' },
}

describe.skipIf(!mongoUrl || !redisUrl || !awsEndpoint)(
  'Express + Mongoose + Redis + SQS + IPinfo',
  () => {
    const run = randomUUID().slice(0, 8)
    const dbName = `ca_stack_${process.pid}_${run}`
    // This run's keys (a Redis server may be shared with other runs).
    const keyPrefix = `{ca-stack-${run}}:`
    // Opened in beforeAll: this body also runs (to collect tests) when the suite is skipped.
    const connection = mongoose.createConnection()
    const redisClient = createClient({ url: redisUrl })
    const sqsClient = new sqs.SQSClient({
      endpoint: awsEndpoint,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    })
    const ipinfoFetch = vi.fn(async (url: string | URL) => {
      const ip = String(url).split('/').at(-2)!
      return new Response(JSON.stringify(IPINFO[ip] ?? { ip, bogon: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const sessions = new Map([['session-1', { id: 'user-1', accountId: 'account-1' }]])

    let queueUrl: string
    let collector: Collector
    let worker: Worker
    let server: Server
    let api: string

    const store = mongoStore({ db: () => connection.db })

    beforeAll(async () => {
      await connection.openUri(mongoUrl, { dbName })
      await redisClient.connect()
      ;({ QueueUrl: queueUrl } = (await sqsClient.send(
        new sqs.CreateQueueCommand({
          QueueName: `ca-stack-${randomUUID()}`,
          Attributes: { VisibilityTimeout: '30' },
        }),
      )) as { QueueUrl: string })
      await ensureMongoIndexes(store)
      // Sites are managed in your own collection (here: one, with credentialed requests).
      await connection.db!.collection('analytics_sites').insertOne({
        siteKey: 'app-site',
        allowedOrigins: [SITE],
        policyVersion: '2026-11-01',
        credentials: true,
      })

      // --- the analytics module of the API (README: "A complete Express API") --------------
      const redis = fromNodeRedis(redisClient)
      const cache = redisCache(redis, { prefix: keyPrefix })
      const queue = sqsQueue({ client: sqsClient, commands: sqs, queueUrl })
      collector = createCollector({
        sites: cachedSites(mongoSites({ db: () => connection.db }), {
          shared: cache,
        }),
        store,
        delivery: {
          events: { mode: 'queued', queue },
          consent: { mode: 'direct' },
        },
        geo: chainGeo(
          trustedHeaderGeo(['cf-ipcountry']),
          ipinfoGeo({
            token: 'test-token',
            cache,
            cacheKeySecret: HASH_SECRET,
            fetch: ipinfoFetch as unknown as typeof fetch,
          }),
        ),
        dataPolicy: balancedDataPolicy(),
        hashSecret: HASH_SECRET,
        identity: { keys: ['userId', 'accountId'] },
        rateLimit: {
          limiter: redisRateLimiter(redis, {
            fallback: memoryRateLimiter(),
            prefix: `${keyPrefix}rl:`,
          }),
          perIp: { limit: 30, windowMs: 60_000 },
        },
        logger: false,
      })

      const app = express()
      app.set('trust proxy', 1)
      // Optional authentication: sets req.user from the session cookie; never rejects.
      app.use((req, _res, next) => {
        const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
        ;(req as { user?: unknown }).user = sid ? sessions.get(sid) : undefined
        next()
      })
      app.use(
        '/analytics',
        collectorMiddleware(collector, {
          identify: req => {
            const user = (req as { user?: { id: string; accountId: string } }).user
            return user ? { userId: user.id, accountId: user.accountId } : null
          },
        }),
      )
      app.use(express.json())
      app.get('/api/me', (_req, res) => void res.json({ ok: true }))
      server = app.listen(0)
      await new Promise(resolve => server.once('listening', resolve))
      api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      // --- the worker process ------------------------------------------------------------------
      worker = runWorker({ queue, store, waitMs: 1_000, logger: false })
    }, 30_000)

    afterAll(async () => {
      await worker?.stop()
      await new Promise(resolve => server?.close(resolve))
      await collector?.close()
      if (queueUrl) await sqsClient.send(new sqs.DeleteQueueCommand({ QueueUrl: queueUrl }))
      sqsClient.destroy()
      await redisClient.quit()
      await connection.dropDatabase()
      await connection.close()
    })

    const call = (path: string, init: { ip: string; body?: unknown; cookie?: string }) =>
      fetch(`${api}/analytics${path}`, {
        method: init.body ? 'POST' : 'GET',
        headers: {
          Origin: SITE,
          'X-Forwarded-For': init.ip,
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
          ...(init.body ? { 'Content-Type': 'text/plain;charset=UTF-8' } : {}),
          ...(init.cookie ? { Cookie: init.cookie } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      })

    const batch = (events: unknown[]) => ({
      v: 1,
      siteKey: 'app-site',
      sentAt: new Date().toISOString(),
      events,
    })
    let seq = 0
    const event = (consent: { required: boolean; granted: boolean }, category = 'full') => ({
      eventId: `stack${String(++seq).padStart(20, '0')}`,
      name: 'page_view',
      occurredAt: new Date().toISOString(),
      sessionId: 'sess0000000000000000000001',
      pageViewId: 'pv000000000000000000000001',
      trackingCategory: category,
      consent,
      props: { url: `${SITE}/pricing?plan=pro`, path: '/pricing', title: 'Pricing' },
    })
    const until = async <T>(read: () => Promise<T | undefined>, ms = 10_000) => {
      const deadline = Date.now() + ms
      for (;;) {
        const value = await read()
        if (value !== undefined) return value
        if (Date.now() > deadline) throw new Error('timed out')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    it('answers the context by the IPinfo location, with credentials for the site', async () => {
      const de = await call('/v1/context?siteKey=app-site', { ip: '81.2.69.142' })
      expect(de.status).toBe(200)
      expect(de.headers.get('Access-Control-Allow-Credentials')).toBe('true')
      expect((await json(de)).policy).toMatchObject({ consentRequired: true, reason: 'region' })
      const us = await call('/v1/context?siteKey=app-site', { ip: '8.8.4.4' })
      expect((await json(us)).policy).toMatchObject({ consentRequired: false })
      // A trusted CDN header wins; no lookup needed.
      const calls = ipinfoFetch.mock.calls.length
      const cdn = await fetch(`${api}/analytics/v1/context?siteKey=app-site`, {
        headers: { Origin: SITE, 'X-Forwarded-For': '1.1.1.9', 'CF-IPCountry': 'FR' },
      })
      expect((await json(cdn)).geo).toEqual({ country: 'FR' })
      expect(ipinfoFetch.mock.calls.length).toBe(calls)
      // Other paths go on to the application.
      expect((await fetch(`${api}/api/me`)).status).toBe(200)
    })

    it('queues events through SQS; the worker stores them enriched, with the identity', async () => {
      const full = event({ required: false, granted: false })
      const response = await call('/v1/events', {
        ip: '8.8.4.4',
        body: batch([full]),
        cookie: 'sid=session-1',
      })
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ accepted: 1, duplicates: 0, rejected: [] })

      const stored = await until(async () =>
        (await store.listEvents({ siteKey: 'app-site' })).find(e => e.eventId === full.eventId),
      )
      expect(stored).toMatchObject({
        profile: 'us-privacy',
        identity: { userId: 'user-1', accountId: 'account-1' },
        server: {
          ip: '8.8.4.4',
          geo: { country: 'US', regionCode: 'US-CA', city: 'Mountain View' },
          network: { asn: 'AS15169', org: 'Google LLC' },
          userAgent: { browser: 'Chrome' },
        },
      })
    })

    it('limited events from a consent region carry no IP address and no identity', async () => {
      const limited = event({ required: true, granted: false }, 'limited')
      await call('/v1/events', {
        ip: '81.2.69.142',
        body: batch([limited]),
        cookie: 'sid=session-1',
      })
      const stored = await until(async () =>
        (await store.listEvents({ siteKey: 'app-site' })).find(e => e.eventId === limited.eventId),
      )
      expect(stored.profile).toBe('gdpr')
      expect(stored.identity).toBeUndefined()
      expect(stored.server?.ip).toBeUndefined()
      expect(stored.server?.geo).toEqual({ country: 'DE' })
      expect(stored.props).toEqual({ url: `${SITE}/pricing`, path: '/pricing', title: 'Pricing' })
    })

    it('writes consent records directly to MongoDB, linked to the account', async () => {
      const record = {
        v: 1,
        siteKey: 'app-site',
        consentId: 'consent00000000000000042',
        decision: 'granted',
        policyVersion: '2026-11-01',
        decidedAt: new Date().toISOString(),
        source: 'banner',
      }
      const response = await call('/v1/consent', {
        ip: '81.2.69.142',
        body: record,
        cookie: 'sid=session-1',
      })
      expect(response.status).toBe(201)
      // Written before the answer: readable at once.
      const [stored] = await store.listConsents({ siteKey: 'app-site' })
      expect(stored).toMatchObject({
        consentId: record.consentId,
        profile: 'gdpr',
        identity: { userId: 'user-1', accountId: 'account-1' },
      })
      // Retried: the same record, not a second one.
      expect((await call('/v1/consent', { ip: '81.2.69.142', body: record })).status).toBe(201)
      expect(await store.listConsents({ siteKey: 'app-site' })).toHaveLength(1)
    })

    it('shares IPinfo answers and site lookups between instances through Redis', async () => {
      const redis = fromNodeRedis(redisClient)
      const secondFetch = vi.fn(ipinfoFetch)
      const siteQueries = vi.fn()
      const second = createCollector({
        sites: cachedSites(
          {
            getSite: siteKey => (siteQueries(siteKey), null),
            isOriginAllowed: () => false,
          },
          { shared: redisCache(redis, { prefix: keyPrefix }) },
        ),
        store,
        geo: ipinfoGeo({
          token: 'test-token',
          cache: redisCache(redis, { prefix: keyPrefix }),
          cacheKeySecret: HASH_SECRET,
          fetch: secondFetch as unknown as typeof fetch,
        }),
        logger: false,
      })
      const { toFetchHandler } = await import('../src/http/fetch.ts')
      const response = await toFetchHandler(second, { getClientIp: () => '81.2.69.142' })(
        new Request('http://second.test/v1/context?siteKey=app-site', {
          headers: { Origin: SITE, 'X-Forwarded-For': '81.2.69.142' },
        }),
      )
      expect(response.status).toBe(200)
      const body = await json(response)
      expect(body.geo).toMatchObject({ country: 'DE' })
      expect(secondFetch).not.toHaveBeenCalled() // the first instance's answer, from Redis
      expect(siteQueries).not.toHaveBeenCalled() // the site, too
      await second.close()
    })

    it('rate limits per client IP across instances (429 with Retry-After)', async () => {
      let limited: Response | undefined
      for (let i = 0; i < 40 && !limited; i++) {
        const response = await call('/v1/context?siteKey=app-site', { ip: '8.8.4.4' })
        if (response.status === 429) limited = response
      }
      expect(limited?.status).toBe(429)
      expect(Number(limited!.headers.get('Retry-After'))).toBeGreaterThan(0)
      // Other visitors are unaffected.
      expect((await call('/v1/context?siteKey=app-site', { ip: '81.2.69.142' })).status).toBe(200)
      // Keys hold no IP address.
      const keys = await redisClient.keys('*')
      expect(keys.join(' ')).not.toContain('8.8.4.4')
    })

    it('runs retention under a Redis lock: one purge at a time', async () => {
      const lock = redisLock(fromNodeRedis(redisClient), { prefix: keyPrefix })
      const options = {
        store,
        dataPolicy: balancedDataPolicy(),
        lock,
        runAtStart: false,
        logger: false as const,
      }
      const a = startRetention(options)
      const b = startRetention(options)
      const results = await Promise.all([a.runNow(), b.runNow()])
      expect(results.filter(result => result === null)).toHaveLength(1)
      await Promise.all([a.stop(), b.stop()])
    })
  },
)
