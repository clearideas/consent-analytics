---
title: Retention and data requests
description: 'Expire events, IP addresses and consent records per region; export or erase one person''s data; how the collector''s features map to a site owner''s duties.'
---

# Retention and data requests

## Retention

Every record carries its own expiry dates, set when it's stored from its profile's
`retention` ([data policy](./data-policy.md)):

| Date | Removes |
| --- | --- |
| `retainUntil` (events) | The event |
| `ipRetainUntil` | `server.ip` from the event |
| `rawUserAgentRetainUntil` | `server.userAgent.raw` from the event |
| `retainUntil` (consent records) | The record |

Whole records expire through the database (MongoDB TTL indexes, DynamoDB TTL) or the purge
job; fields are always removed by the purge job. Run it in one process, for example the
worker:

```ts
import { startRetention } from '@clearideas/consent-analytics-server'

const retention = startRetention({
  store,
  // optional: also apply today's (shorter) limits to older records
  dataPolicy,
  // optional: one purge at a time across processes
  lock: redisLock(redis),
  // default: hourly
  everyMs: 3_600_000,
})
process.on('SIGTERM', () => void retention.stop())
```

| Option | Default | |
| --- | --- | --- |
| `store` | required | A store with `purge` (every included store) |
| `dataPolicy` | none | With it, records of each profile received before the policy's current cutoff are removed too, so shortening a retention period applies to data already stored. |
| `everyMs` | 1 hour | How often to purge |
| `runAtStart` | `true` | Purge once right away |
| `lock` | none | `{ acquire(name, ttlMs) }`; with several processes, only the holder purges |
| `logger`, `onResult` | | Each run's counts: events deleted, IP addresses and raw user agents removed, consent records deleted |

`retention.runNow()` purges at once (and returns `null` if another process holds the lock).
For a scheduled job instead of a timer (a cron job, a Lambda function), call
`purgeExpired({ store, dataPolicy })` once.

Without `retention` in a profile, its records never expire: set one for each profile.

## Data subject requests

Every included store can export and erase one person's data:

```ts
const data = await store.exportSubject({
  siteKey: 'my-site',
  identity: { userId: 'u-123' },
})
// { events: [...], consents: [...], identities: [...] }

const result = await store.eraseSubject({
  siteKey: 'my-site',
  identity: { userId: 'u-123' },
})
// { eventsDeleted, consentsDeidentified, identitiesDeleted }
```

**Selectors** (at least one person-level criterion; records matching any are included,
optionally limited to one `siteKey`):

| Criterion | Finds |
| --- | --- |
| `identity` | Records whose identity has all the given keys and values (signed-in visitors) |
| `consentId` | The visitor's consent records, by the browser's consent ID |
| `sessionId` | The events of one browser session |

Anonymous visitors can be found only through IDs from their own browser: the consent ID
(in `ci_consent_status`, in their `localStorage`) or a session ID. Limited events are
anonymous by design and can't be attributed to a person.

**Erasure** deletes the person's events and identity records. **Consent records are kept,
but de-identified**: the identity is removed, while the proof of what was decided, under
which policy and when, remains.

There is no built-in HTTP endpoint for these requests: call the store from your own
authenticated admin tooling.

## How the features map to a site owner's duties

This describes what the software does; whether it meets your obligations is for you and
your advisers to decide.

| Duty (GDPR unless noted) | What the collector does |
| --- | --- |
| Show that consent was given (Art. 7(1)) | Append-only consent records with the policy version, time, source and, for signed-in visitors, the account; retried records stored once |
| Consent only for what visitors were told (Art. 4(11)) | Decisions are per `policyVersion`; records for an outdated version are annotated |
| No processing beyond consent (Art. 6, ePrivacy Art. 5(3)) | The [event rules](./rules.md) downgrade or reject events that claim more than the visitor allowed; limited events lose non-allowlisted fields |
| Data minimization and protection by default (Art. 5(1)(c), Art. 25) | Per-region profiles decide what is derived; limited events never get an IP address or identity; IP truncation and hashing; rate-limit and cache keys never contain IP addresses |
| Storage limitation (Art. 5(1)(e)) | Per-profile retention for events, IP addresses, raw user agents and consent records; the purge job; TTL indexes |
| Access and portability (Art. 15, 20) | `exportSubject` |
| Erasure (Art. 17) | `eraseSubject`, keeping de-identified consent evidence |
| Opt-out of sale or sharing (US state laws) | Global Privacy Control honored in the browser (marketing) and in data policies (`onGlobalPrivacyControl`) |
| Unknown location | Treated as consent required |

Your own duties remain: a privacy notice, a record of processing, security of the database,
processor agreements for hosting, and answering requests within the legal deadlines.
