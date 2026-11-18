---
title: How the collector works
description: 'What happens to each request in the collector, from the origin check to storage, and the building blocks you configure.'
---

# How the collector works

A collector is created once, from options, and mounted in one or more transports:

```ts
const collector = createCollector({
  sites,
  store,
  geo,
  dataPolicy,
  delivery,
  rules,
  identity,
})
app.use('/analytics', collectorMiddleware(collector)) // Express
// or createCollectorServer(collector), toNodeHandler(collector),
// or toFetchHandler(collector)
```

The transport turns the framework's request into a neutral one (method, path, headers,
client IP, a body reader, the signed-in visitor) and writes the answer back. Everything
else happens in the collector.

## The request pipeline

<div class="ca-flow">
  <div><strong>Route and origin</strong><br/><small>CORS, site, rate limits</small></div>
  <span>→</span>
  <div><strong>Validate</strong><br/><small>type, size, contract</small></div>
  <span>→</span>
  <div><strong>Policy</strong><br/><small>region → profile</small></div>
  <span>→</span>
  <div><strong>Rules</strong><br/><small>consent, allowlist, time</small></div>
  <span>→</span>
  <div><strong>Enrich</strong><br/><small>what the profile allows</small></div>
  <span>→</span>
  <div><strong>Deliver</strong><br/><small>store, buffer or queue</small></div>
</div>

For `POST /v1/events`:

1. **Route and origin.** The path must be one of the collector's (`/v1/context`,
   `/v1/events`, `/v1/consent`, `/v1/health`); others get `404` (or go to `next()` in
   middleware). Browsers send `Origin`: it must be allowed by a site, otherwise `403`.
   `OPTIONS` preflights are answered here. A per-IP rate limit, if configured, is checked
   before the body is read.
2. **Validate.** `text/plain` or `application/json` only (`415`), at most 64 KiB, read as it
   streams (`413`). The batch is validated against the contract; a bad envelope is `400`,
   while each invalid event is reported in `rejected[]` and the rest is kept. The site must
   exist (`404`) and allow the origin (`403`); a per-site rate limit is checked.
3. **Policy.** The visitor's region comes from the [geo resolver](./sites-and-geo.md#location)
   (unknown if there is none, or it fails). The [data policy](./data-policy.md) maps the
   region to a **profile**: whether consent is required, what to add to events, how long
   to keep them. The site's `consentMode` can override the requirement.
4. **Rules.** Each event is checked against the visitor's consent: a full event without
   consent where it's required becomes limited, limited events lose the fields they may not
   carry, and times are corrected for clock skew. Events that can't be allowed are rejected.
   See [Event rules](./rules.md).
5. **Enrich.** For each kept event, the collector adds what the profile allows for its
   category: IP address, location, network, parsed user agent, language, Global Privacy
   Control, privacy flags, and the signed-in visitor's identity. Limited events never get an
   IP address or identity. It also computes a typed projection of the props (page,
   attribution, engagement, ...) and the retention dates. See [Stored data](./stored-data.md).
6. **Deliver.** The finished records go to the store directly (the answer waits for the
   write), through an in-process buffer, or through a queue to a [worker](./delivery.md).
   If delivery fails, the answer is `503` with `Retry-After`, and browsers retry.

The answer is `202` with `accepted`, `duplicates` and `rejected`.

`POST /v1/consent` follows the same path with one record: it's validated, annotated (never
modified: records are evidence), given a deterministic `recordId`, linked to the signed-in
visitor, and delivered. `GET /v1/context` stops after step 3 and answers the policy.

## Building blocks

| Option | What it is | Default |
| --- | --- | --- |
| `sites` | Site definitions, or a [site source](./sites-and-geo.md#site-sources) (a database, a cache) | required |
| `store` | Where records are written: a [store adapter](./storage.md) | required unless both endpoints are queued |
| `geo` | How to find the visitor's region: CDN headers, IPinfo, your own | none: the region is unknown, so consent is required everywhere |
| `dataPolicy` | Regions → profiles: consent, enrichment, retention | `balancedDataPolicy()` |
| `rules` | How inconsistent events are handled | `{ preset: 'standard' }` |
| `delivery` | Per endpoint: `direct`, `buffered` or `queued` | `direct` |
| `identity`, `identify` | Which identity keys to store, and where the signed-in visitor comes from | keys `userId`, `accountId`; no `identify` |
| `rateLimit` | Per-IP and per-site limits | none |
| `hashSecret` | Secret for hashed IP addresses and rate-limit keys | none |
| `logger`, `hooks` | Logging (pino-compatible) and error reporting | warnings and errors on stderr |

All options: [Collector options](./configuration.md).

## Responses and errors

- Every response has `X-Request-Id` (a valid incoming one is kept), and log entries carry it.
- Errors are problem details (`application/problem+json`): `{ type, title, status, detail?, errors? }`.
- CORS headers are on every response to an allowed origin, errors included, so browsers can
  read them. `Access-Control-Allow-Credentials` is sent only for sites with `credentials: true`.
- A failing store, queue or site source gives `503` with `Retry-After` (5 seconds by default);
  `hooks.onError` is called and the error is logged.
- Unexpected errors are `500` in the standalone transports, and go to your error handler
  (`next(error)`) in Express.

## Lifecycle

- `collector.close()` writes what is buffered (up to `flushTimeoutMs`, 10 s by default), then
  closes the store. `createCollectorServer().close()` calls it after in-flight requests finish.
  In your own server, call it on shutdown.
- `collector.stats()` reports, per endpoint, the delivery mode and, for buffers, how much is
  buffered, written, retried and lost.
