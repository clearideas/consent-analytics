---
title: Collector options
description: 'Reference of createCollector options, the transports, the worker, retention and the adapters.'
---

# Collector options

## `createCollector(options)`

| Option | Type | Default | |
| --- | --- | --- | --- |
| `sites` | `SiteInput[]` or `SiteSource` | required | [Sites](./sites-and-geo.md#sites), or a [site source](./sites-and-geo.md#site-sources) |
| `store` | `CollectorStore` | required unless both endpoints are queued | [Stores](./storage.md) |
| `delivery` | `{ events?, consent? }` | `direct` for both | [Delivery](./delivery.md): `{ mode: 'direct' }`, `{ mode: 'buffered', ... }` or `{ mode: 'queued', queue, ack?, ... }` |
| `flushTimeoutMs` | number | 10 000 | On `close()`, how long buffered data may take to be written |
| `geo` | `GeoResolver` | none: region unknown, consent required | [Location](./sites-and-geo.md#location) |
| `dataPolicy` | policy document or compiled policy | `balancedDataPolicy()` | [Data policies](./data-policy.md) |
| `rules` | `RulesOptions` | `{ preset: 'standard' }` | [Event rules](./rules.md): `preset`, `maxPastDays`, `maxFutureMinutes`, `custom` |
| `hashSecret` | string (16+ characters) | none | Required for `ip: 'hashed'`; used for rate-limit keys. The same on every instance. |
| `identify` | `(request) => identity \| null` | none | The signed-in visitor, for transports without their own `identify` ([Signed-in visitors](./identity.md)) |
| `identity` | `IdentityOptions` | keys `userId`, `accountId` | `keys`, `traits`, `maxValueLength` (256), `consentRecords` (`true`) |
| `rateLimit` | object | none | `{ limiter, perIp?, perSite?, onError? }` ([Rate limits](./redis.md#rate-limits)) |
| `contextTtlSeconds` | 0 to 86 400 | 3 600 | How long browsers may cache `GET /v1/context` |
| `retryAfterSeconds` | number | 5 | `Retry-After` of `503` answers |
| `logger` | `Logger` or `false` | warnings and errors as JSON lines on stderr | Any pino-compatible logger: `debug`/`info`/`warn`/`error(fields, message)` |
| `hooks.onError` | `(error, { operation, requestId }) => void` | none | Called for store, queue and site source failures and unexpected errors. A throwing hook can't break a response. |
| `clock` | `() => Date` | the system clock | For tests |

`createCollector` validates its options (sites, data policy, identity names, delivery,
`contextTtlSeconds`, `hashSecret` for hashed IPs) and throws on an invalid one, so a
misconfiguration fails at startup.

### The collector

```ts
interface Collector {
  // used by the transports
  handle(request: CollectorRequest): Promise<CollectorResponse>
  // the paths it answers
  readonly paths: readonly string[]
  // writes what is buffered (up to flushTimeoutMs), closes the store
  close(): Promise<void>
  // mode; buffered, written, failedFlushes, lost
  stats(): { events: DeliveryStats; consent: DeliveryStats }
}
```

## Transports

| Function | Import | Options |
| --- | --- | --- |
| `collectorMiddleware(collector, options)` | `/express` | `identify(req)`, `logger` (for the one-time body warning). The client IP is `req.ip`. |
| `toNodeHandler(collector, options)` | `/node` | `basePath`, `trustProxy` |
| `createCollectorServer(collector, options)` | `/node` | `port` (8787), `host` (`0.0.0.0`), `basePath`, `trustProxy`, `headersTimeoutMs` (10 000), `requestTimeoutMs` (30 000), `keepAliveTimeoutMs` (5 000), `shutdownTimeoutMs` (10 000), `routes` |
| `toFetchHandler(collector, options)` | `/fetch` | `basePath`, `getClientIp(request)` |

See [Express](./express.md) and [node:http and Fetch platforms](./node-and-fetch.md).

## Worker and retention

| Function | Options |
| --- | --- |
| `runWorker({ queue, store, ... })` | `batchSize` (10), `waitMs` (20 000), `concurrency` (1), `maxAttempts` (10), `retryBaseMs` (1 000), `retryMaxMs` (300 000), `outageBaseMs` (1 000), `outageMaxMs` (60 000), `logger`, `hooks.onError`, `hooks.onDeadLetter`. Returns `{ stop(), stats() }`. |
| `startRetention({ store, ... })` | `dataPolicy`, `everyMs` (3 600 000), `runAtStart` (`true`), `lock`, `logger`, `onResult`. Returns `{ runNow(), stop() }`. |
| `purgeExpired({ store, dataPolicy?, now? })` | One purge. |
| `createIngestProcessor({ store, logger })` | `process(bodies)`: decode and write queue messages yourself. |

## Adapters

| Function | Options |
| --- | --- |
| `memoryStore()` | none |
| `mongoStore({ db, collections? })` | `db`: a `Db` or a function returning one; `collections`: `{ events, consents, identities }` names (`analytics_events`, ...) |
| `ensureMongoIndexes(store, { identityKeys?, ttl? })` | Identity keys to index (default `userId`, `accountId`); `ttl: false` skips the TTL indexes |
| `mongoSites({ db, collection?, logger? })` | `collection`: default `analytics_sites` |
| `postgresStore({ db, prefix? })`, `migratePostgres(db, { prefix? })` | `prefix`: table prefix, default `analytics_` |
| `mysqlStore({ db, prefix? })`, `migrateMysql(db, { prefix? })` | same |
| `dynamoStore({ client, commands, table, concurrency? })` | `concurrency`: parallel writes per batch (10) |
| `createDynamoTable({ client, commands, table })` | Creates the table with TTL |
| `sqliteStore({ path?, database? })` | `path` (or `:memory:`), or an open `DatabaseSync` |
| `sqsQueue({ client, commands, queueUrl, deadLetterQueueUrl? })` | |
| `redisStreamQueue(redis, { stream?, group?, consumer?, visibilityTimeoutMs?, deadLetterStream? })` | |
| `redisRateLimiter(redis, { prefix?, fallback?, onError? })` | |
| `redisCache(redis, { prefix? })`, `redisLock(redis, { prefix? })` | |
| `memoryRateLimiter({ maxKeys?, clock? })` | `maxKeys`: 100 000 |
| `memoryQueue(options?)` | For tests and single processes |
| `memoryCache({ maxEntries?, clock? })` | |
| `ipinfoGeo({ token, url?, timeoutMs?, cache?, ttlMs?, cacheKeySecret?, fetch?, logger? })` | `timeoutMs` 150, `ttlMs` 24 hours |
| `trustedHeaderGeo(headers, { continentHeaders? })`, `fixedGeo(geo)`, `chainGeo(...resolvers)` | |
| `staticSites(list)`, `cachedSites(source, { ttlMs?, negativeTtlMs?, maxEntries?, shared?, sharedPrefix? })`, `chainSites(...sources)` | `ttlMs` 60 000, `negativeTtlMs` 10 000 |

## Protocol module

The contract's validators and types, generated from `spec/openapi.yaml`:

```ts
import {
  validate,
  LIMITED_TRACKING,
  EVENT_CATALOG,
  type EventBatch,
} from '@clearideas/consent-analytics-server'

// [] when valid, else [{ path: '/events/0/name', message: '...' }, ...]
validate('EventBatch', body)
```

- `validate(schema, value)` covers every schema in the contract, with a type for each.
- `LIMITED_TRACKING` lists the event names and fields `limited` events may carry.
- `EVENT_CATALOG` maps each standard event to its props schema.
- `SPEC_VERSION` is the contract version the package implements.
