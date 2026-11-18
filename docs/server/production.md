---
title: Production guide
description: 'A checklist, security boundaries, deployment topologies, scaling, observability and upgrades for a production collector.'
---

# Production guide

## Checklist

**Configuration**

- A persistent [store](./storage.md), migrated at deploy time (or with `AUTO_MIGRATE`), and
  backed up.
- Each site's `allowedOrigins` lists exactly your production origins (not `localhost`).
- A [location source](./sites-and-geo.md#location): a header your CDN overwrites on every
  request, or IPinfo. Without one, everyone gets the banner.
- [`trustProxy`](./node-and-fetch.md#client-ip) (or Express's `trust proxy`) matches your
  proxies exactly.
- `hashSecret`: long and random, from your secret manager, the same on every instance.
- The [data policy](./data-policy.md) reviewed for your regions, with **retention** for
  every profile.
- The [retention job](./retention-and-privacy.md) running in one place (with a lock if
  several processes run it).
- [Delivery](./delivery.md) chosen deliberately: consent records `direct` or `queued`
  durable.
- Generous [rate limits](./redis.md#rate-limits), shared through Redis with several
  instances.

**Operations**

- `collector.close()` on shutdown (the standalone server and collector do it).
- Logs collected, with `hooks.onError` reporting to your error tracker.
- Alerts on `503` rates, dead letters and lost buffered records.
- A readiness check that includes the store (`store.health()`).
- A documented process for [data subject requests](./retention-and-privacy.md#data-subject-requests).

## Topologies

**Inside your API.** The collector is middleware in the API that serves your site. Simplest;
identity from your session cookie comes for free. Writes use your API's database pool.

**A standalone service.** The [standalone collector](./collector.md) (or your own small
server with the library) on its own hostname, for example `collector.example.com`. It scales and
deploys independently; for identity it must share your site's domain.

**API and workers.** The API validates, enriches and queues; workers write in bulk. Use it
for spiky traffic, slow or remote databases, or to keep the API's latency independent of the
database:

<div class="ca-flow">
  <div><strong>Browsers</strong></div>
  <span>→</span>
  <div><strong>CDN / load balancer</strong><br/><small>country header, TLS</small></div>
  <span>→</span>
  <div><strong>API instances</strong><br/><small>stateless, Redis for limits and caches</small></div>
  <span>→</span>
  <div><strong>Queue</strong><br/><small>Redis Streams or SQS</small></div>
  <span>→</span>
  <div><strong>Workers</strong><br/><small>bulk writes, retention</small></div>
  <span>→</span>
  <div><strong>Database</strong></div>
</div>

## Security

The collector's endpoints are **public by design**: any page on an allowed origin must be able
to call them, without authentication. Keep that in mind:

- **Origins protect browsers, not your data.** CORS and the origin check stop other websites'
  pages from using your site key in visitors' browsers. A script outside a browser can send any
  `Origin` header. Treat stored events as untrusted input: anyone can send plausible-looking
  events.
- **Limit abuse** with rate limits, `eventNames.allow` lists for sites with a known set of
  events, body size limits (built in), and filtering of bot traffic in reporting
  (`server.userAgent.isBot`, with `userAgent: 'parsed'` in the profile).
- **Escape stored values** wherever you display them (dashboards, admin tools): props are free
  text from browsers.
- **Keep reads private.** The collector has no read API. Export, erasure and reporting
  belong in your authenticated tools, never on the collector's public routes.
- **Trust headers deliberately.** A trusted geo header or `trustProxy: true` that clients can
  set lets them choose their consent policy or IP address. The collector must not be
  reachable around the proxy that sets them.
- **Secrets:** `hashSecret`, database credentials, the IPinfo token and queue credentials
  belong in your secret manager. The site key is public.
- **Credentialed sites** (`credentials: true`) accept cookies from their origins only. Keep
  `allowedOrigins` of those sites exact, and your `identify` function strict: it must trust only
  your own session check.

## Scaling

- The API is **stateless**: run as many instances as you need. With several, share rate limits
  and caches through Redis (otherwise each instance counts and caches on its own).
- **Volume:** a page view produces roughly 5 to 10 events (`page_view`, `page_exit`, web
  vitals, `auto_metrics` twice, scroll depth) in one or two requests, plus one context request
  per session and one consent request per decision.
- **Writes** are the bottleneck before the API is. Bulk writes through a queue and workers
  (`batchSize`, `concurrency`) smooth peaks; the direct mode writes one batch per request.
- **Indexes:** the included migrations index site and time, session, event name, profile,
  retention and identity. Add your own for your reports. For very large Postgres or MySQL
  tables, consider partitioning by time; for DynamoDB, export to S3 for reporting.
- **Retention** keeps tables at a steady size. MongoDB and DynamoDB expire whole records
  themselves; the purge job handles fields and the SQL stores.

## Observability

- **Logs:** pass your logger (`logger`, pino-compatible). Entries are structured, carry the
  request ID, and never contain request bodies. The default writes warnings and errors as JSON
  lines to stderr.
- **Request IDs:** every answer has `X-Request-Id`; a valid incoming one is kept, so IDs from
  your load balancer flow through.
- **Errors:** `hooks.onError(error, { operation, requestId })` is called for every store,
  queue and site source failure (`store.insertEvents`, `queue.send`, `sites.getSite`, ...) and
  unexpected errors.
- **Delivery:** `collector.stats()` (buffered, written, failed flushes, lost per endpoint) and
  `worker.stats()` (received, written, retried, dead-lettered). The standalone collector exposes
  them as [Prometheus metrics](./collector.md#metrics).
- **Dead letters:** `hooks.onDeadLetter` on the worker; inspect and replay them from the
  dead-letter stream or queue.

## Upgrades

- **Store migrations** are idempotent and recorded (`<prefix>schema_migrations`); run them
  before starting new instances. `ensureMongoIndexes` is idempotent too.
- **The contract** (`spec/openapi.yaml`) is versioned. Changes within v1 are additive:
  existing browsers keep working with a newer collector.
- **Queue messages** are versioned. A worker refuses versions it doesn't know (dead-lettered),
  so upgrade workers before or together with the API when a release changes the message
  format (the changelog says so).
- **Data policy changes** apply to new records at once; use the retention job with the policy
  to apply shorter limits to stored data.
