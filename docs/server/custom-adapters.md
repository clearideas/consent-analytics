---
title: Custom adapters
description: 'Write your own store, queue, geo resolver, site source, rate limiter, cache, lock or logger, and test it with the conformance suites.'
---

# Custom adapters

Everything the collector talks to is a small interface. The included adapters implement
them; you can implement them for anything else.

## Stores

```ts
import type {
  CollectorStore,
  StoredConsent,
  StoredEvent,
} from '@clearideas/consent-analytics-server'

const myStore: CollectorStore = {
  async insertEvents(events) {
    // (siteKey, eventId) is unique: repeats are duplicates,
    // also within this batch.
    const inserted = await db.insertIgnoringDuplicates(events)
    return { inserted, duplicates: events.length - inserted }
  },
  async insertConsent(record) {
    // recordId is unique: a repeat is a duplicate;
    // return the stored record's recordedAt.
    const existing = await db.findConsent(record.recordId)
    if (existing) return { duplicate: true, recordedAt: existing.recordedAt }
    await db.insertConsent(record)
    return { duplicate: false, recordedAt: record.recordedAt }
  },
}
```

Rules:

- **Idempotent.** Browsers and queues retry: the same event or record must be stored once,
  and counted as a duplicate, never as an error.
- **Throw on infrastructure failures** (connection lost, timeout). The collector answers `503`
  with `Retry-After` and the browser retries; in a worker, the message is retried.
- **Store records as given.** Keep `props` exactly as received (including nested objects and
  keys with dots), and keep the times as given (or convert them losslessly).
- Optional methods: `upsertIdentity` (traits per identity; latest values win), `purge`
  (retention: remove records whose `retainUntil` has passed, and the IP address and raw user
  agent of events whose `ipRetainUntil`/`rawUserAgentRetainUntil` has passed; apply
  `options.profiles` cutoffs), `exportSubject` and `eraseSubject` (data subject requests:
  erase events and identities, de-identify consent records), `health` and `close`.

The types (`StoredEvent`, `StoredConsent`, `StoredIdentity`, `PurgeOptions`, `PurgeResult`,
`SubjectSelector`, ...) are exported from the main entry point. Helpers for `purge` and
subject requests are too: `due(date, now)`, `siteMatches`, `identityMatches`,
`profileCutoffs`.

## Queues

```ts
interface IngestQueue {
  send(bodies: readonly string[]): Promise<void>
  receive(options: {
    max: number
    waitMs: number
    signal?: AbortSignal
  }): Promise<ReceivedMessage[]>
  ack(messages: readonly ReceivedMessage[]): Promise<void>
  retry(message: ReceivedMessage, delayMs: number): Promise<void>
  deadLetter(message: ReceivedMessage, reason: string): Promise<void>
  close?(): Promise<void>
}

interface ReceivedMessage {
  body: string
  attempts: number // deliveries so far, including this one (the first is 1)
  handle: unknown // your receipt: message ID, receipt handle, ...
}
```

What the worker relies on:

- **At-least-once delivery.** A received message that isn't acknowledged (the worker
  crashed) is delivered again after a visibility timeout, with `attempts` increased.
- **`receive`** waits up to `waitMs` for messages (long polling), returns at most `max`, and
  returns early when `signal` aborts (on `worker.stop()`).
- **`retry`** makes the message visible again after `delayMs`, with `attempts` increased on
  the next delivery.
- **`deadLetter`** removes the message for good and keeps it somewhere for inspection.
- Concurrent consumers must not receive the same message at the same time.

A producer-only queue (just `send`) is enough for the API side (`delivery: { mode: 'queued' }`).

## Location

```ts
import type { GeoResolver } from '@clearideas/consent-analytics-server'

const geo: GeoResolver = async ({ clientIp, headers }) => {
  const answer = await lookup(clientIp)
  return answer
    ? { country: answer.country, regionCode: answer.subdivision }
    : null
}
```

Return `null` when unknown. Answers are validated: an invalid `country` makes the answer
count as unknown, and invalid optional fields are dropped. Keep it fast (it runs on
`GET /v1/context` and every batch): cache, and time out. A throwing resolver counts as
unknown.

## Site sources

```ts
import type { SiteSource } from '@clearideas/consent-analytics-server'
import { cachedSites, defineSite } from '@clearideas/consent-analytics-server'

const fromMyDatabase: SiteSource = {
  async getSite(siteKey) {
    const row = await db.sites.find(siteKey)
    return row ? defineSite(row) : null   // validates and fills defaults
  },
  async isOriginAllowed(origin) {
    return db.sites.anyAllows(origin)
  },
  async isCredentialedOrigin(origin) {     // optional
    return db.sites.anyAllowsWithCredentials(origin)
  },
}
const sites = cachedSites(fromMyDatabase)
```

Throw on infrastructure failures (the collector answers `503`); return `null` for an unknown
site.

## Rate limiters, caches and locks

```ts
interface RateLimiter {
  consume(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }>
}
interface Cache {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, ttlMs: number): Promise<void>
}
interface Lock {
  // release function, or null if held
  acquire(name: string, ttlMs: number): Promise<(() => Promise<void>) | null>
}
```

## Loggers

Any object with `debug`, `info`, `warn` and `error(fields, message)`: pino works as is. For
others, adapt:

```ts
const logger = {
  debug: (fields, message) => winston.debug(message, fields),
  info: (fields, message) => winston.info(message, fields),
  warn: (fields, message) => winston.warn(message, fields),
  error: (fields, message) => winston.error(message, fields),
}
```

## Testing with the conformance suites

The repository has the tests every included store and queue passes:
`server/test/support/store-conformance.ts` and `server/test/support/queue-conformance.ts`
(Vitest). They aren't part of the package; copy them, or run your adapter against them in a
checkout:

```ts
import { runStoreConformance } from './support/store-conformance.ts'
import { myStore, clearMyStore } from '../my-store.ts'

runStoreConformance('myStore', async () => ({
  store: myStore,
  // listEvents/listConsents, for the tests to read back
  reader: myStore,
  cleanup: () => clearMyStore(),
}))
```

They check idempotency (also within one batch and under concurrency), exact round-trips,
purge and subject requests for stores; and at-least-once delivery, attempt counts,
visibility timeouts, delayed retries, dead letters, long polling and concurrent consumers for
queues.
