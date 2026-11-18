---
title: Express
description: 'Mount the collector in an Express 5 or 4 application, with your authentication, database, queue and location service.'
---

# Express

The collector is one middleware. It answers its own paths and passes everything else on.

```ts
import express from 'express'
import { createCollector } from '@clearideas/consent-analytics-server'
import { collectorMiddleware } from '@clearideas/consent-analytics-server/express'

const collector = createCollector({ sites, store, geo })

const app = express()
// real client IPs behind one proxy
app.set('trust proxy', 1)
app.use('/analytics', collectorMiddleware(collector))
// your middleware can come after
app.use(express.json())
// ... your routes
```

In the browser: `apiBaseUrl: 'https://api.example.com/analytics'`.

Express itself is not imported: the middleware works with the Express you have, and is
tested with Express 5 and 4.

## Mounting

- Mount it at a path (`/analytics`) or at the root. Paths that aren't the collector's go to
  `next()`, so your routes keep working either way.
- **Mount it before body parsers if you can.** If `express.json()`, `express.text()` or
  `express.raw()` already read the body, the middleware uses the parsed body, and the size
  limits still apply. If something else consumed the body, the request gets `400`, and a
  one-time warning says what to do.
- **A global `cors()`** is fine: the collector replaces any CORS headers it set, so its
  settings (for example `credentials: true`) never leak onto collector routes. `cors()`
  answers `OPTIONS` preflights itself, which is harmless: the browser library sends only
  requests that need no preflight.
- **Client IP.** The middleware uses `req.ip`, which follows Express's `trust proxy`
  setting. Set it to match your proxies (`1` behind one load balancer), or the collector sees
  the proxy's address.
- **Errors.** Protocol errors (`400`, `403`, `404`, `413`, `415`, `429`, `503`) are answered
  by the collector. Anything unexpected goes to your error handler with `next(error)`.

## Authentication

Your authentication middleware must **not reject anonymous visitors** on the collector's
path, or their events and consent records would be refused. Run it in an optional mode
(set `req.user` if the cookie is valid, continue otherwise), or mount the collector before
it.

To identify signed-in visitors, return them from `identify`:

```ts
// sets req.user from a valid session cookie; never rejects
app.use(optionalAuth)
app.use(
  '/analytics',
  collectorMiddleware<express.Request & { user?: User }>(collector, {
    identify: req =>
      req.user ? { userId: req.user.id, accountId: req.user.accountId } : null,
  }),
)
```

`identify` is used only for sites with `credentials: true`; the browser must send cookies
(`credentials: 'include'`). A failing `identify` is logged and treated as anonymous. See
[Signed-in visitors](./identity.md).

## Shutdown

Call `collector.close()` when the process stops, so buffered data is written:

```ts
const server = app.listen(3000)
process.on('SIGTERM', () => {
  server.close(async () => {
    // flushes buffers (up to flushTimeoutMs), then closes the store
    await collector.close()
    process.exit(0)
  })
})
```

## A complete example

Express 5 with Mongoose, Redis, SQS and IPinfo: events go through SQS to a worker, consent
records are written before answering, sites live in your own MongoDB collection, and
signed-in visitors are identified from your session cookie. The repository's
`server/test/stack.test.ts` runs this setup against real services.

```ts
// analytics.ts
import * as sqs from '@aws-sdk/client-sqs'
import mongoose from 'mongoose'
import {
  balancedDataPolicy,
  cachedSites,
  chainGeo,
  createCollector,
  memoryRateLimiter,
  trustedHeaderGeo,
} from '@clearideas/consent-analytics-server'
import { ipinfoGeo } from '@clearideas/consent-analytics-server/ipinfo'
import {
  ensureMongoIndexes,
  mongoSites,
  mongoStore,
} from '@clearideas/consent-analytics-server/mongodb'
import {
  fromNodeRedis,
  redisCache,
  redisLock,
  redisRateLimiter,
} from '@clearideas/consent-analytics-server/redis'
import { sqsQueue } from '@clearideas/consent-analytics-server/sqs'

// e.g. your pino instance
import { logger } from './logger.js'
// your connected node-redis client
import { redisClient } from './redis.js'

const redis = fromNodeRedis(redisClient)
const cache = redisCache(redis)
const db = () => mongoose.connection.db
// long, random, the same on every instance
const hashSecret = process.env.ANALYTICS_HASH_SECRET!

export const dataPolicy = balancedDataPolicy()
export const store = mongoStore({ db })
export const queue = sqsQueue({
  client: new sqs.SQSClient({}),
  commands: sqs,
  queueUrl: process.env.ANALYTICS_QUEUE_URL!,
})
export const lock = redisLock(redis)

export const collector = createCollector({
  // Documents like
  // { siteKey, allowedOrigins, policyVersion, credentials: true }
  sites: cachedSites(mongoSites({ db }), { shared: cache }),
  store,
  delivery: {
    // a worker writes them
    events: { mode: 'queued', queue },
    // evidence: written before answering
    consent: { mode: 'direct' },
  },
  geo: chainGeo(
    trustedHeaderGeo(['cf-ipcountry']), // only if your CDN sets it
    ipinfoGeo({
      token: process.env.IPINFO_TOKEN!,
      cache,
      cacheKeySecret: hashSecret,
    }),
  ),
  dataPolicy,
  hashSecret,
  identity: { keys: ['userId', 'accountId'] },
  rateLimit: {
    limiter: redisRateLimiter(redis, { fallback: memoryRateLimiter() }),
    perIp: { limit: 600, windowMs: 60_000 },
  },
  logger,
})

// Once, after mongoose.connect() (or in your migrations):
export const prepareAnalytics = () => ensureMongoIndexes(store)
```

```ts
// app.ts
import { collectorMiddleware } from '@clearideas/consent-analytics-server/express'
import { collector, prepareAnalytics } from './analytics.js'

await mongoose.connect(process.env.MONGODB_URL!)
await prepareAnalytics()

app.set('trust proxy', 1)
app.use(optionalAuth)
app.use(
  '/analytics',
  collectorMiddleware(collector, {
    identify: req =>
      req.user ? { userId: req.user.id, accountId: req.user.accountId } : null,
  }),
)
```

```ts
// worker.ts: its own process (or in the API process)
import { runWorker, startRetention } from '@clearideas/consent-analytics-server'
import { dataPolicy, lock, queue, store } from './analytics.js'

await mongoose.connect(process.env.MONGODB_URL!)
const worker = runWorker({ queue, store, logger })
// TTL indexes expire whole records
const retention = startRetention({ store, dataPolicy, lock })
process.on('SIGTERM', async () => {
  await worker.stop()
  await retention.stop()
  process.exit(0)
})
```

In the browser: `apiBaseUrl: 'https://api.example.com/analytics'` and
`credentials: 'include'`.

What each piece does:

| Piece | Page |
| --- | --- |
| `mongoSites`, `cachedSites` with a shared cache | [Site sources](./sites-and-geo.md#site-sources) |
| `trustedHeaderGeo`, `ipinfoGeo`, `chainGeo` | [Location](./sites-and-geo.md#location) |
| `queued` events, `direct` consent, the worker | [Delivery and queues](./delivery.md) |
| `mongoStore`, `ensureMongoIndexes` | [Stores](./storage.md#mongodb) |
| `redisRateLimiter`, `redisCache`, `redisLock` | [Redis and rate limits](./redis.md) |
| `identity`, `identify` | [Signed-in visitors](./identity.md) |
| `startRetention` | [Retention](./retention-and-privacy.md) |

## Express 4

The same code works. Express 4 doesn't catch errors in async middleware; the collector
middleware handles its own, and passes unexpected ones to `next(error)`.
