---
title: Troubleshooting the collector
description: 'What common errors mean, and what to check when requests are refused, data is missing or the collector answers 503.'
---

# Troubleshooting

## Answers and what they mean

| Answer | Meaning | Check |
| --- | --- | --- |
| `403 Origin not allowed` | The request's `Origin` isn't in any site's `allowedOrigins` | The exact origin: scheme, host and port. `https://example.com` ≠ `https://www.example.com`. |
| `404 Unknown site key` | No site with this key | The site definition, or the site source (a cached unknown answer is kept for `negativeTtlMs`, 10 s) |
| `404 Not found` | Not one of the collector's paths | `basePath`, or where the middleware is mounted, versus the browser's `apiBaseUrl` |
| `405 Method not allowed` | For example a `GET` to `/v1/events` | |
| `400 Malformed JSON`, `400 Invalid request` | The body isn't valid JSON, or doesn't match the contract | The answer's `errors` list the fields |
| `400 Could not read the request body` (Express) | An earlier middleware consumed the body in a form the collector can't use | Mount the collector before that middleware; a one-time warning in the log says which |
| `413 Payload too large` | Over 64 KiB (events) or 4 KiB (consent) | |
| `415 Unsupported media type` | Not `text/plain` or `application/json` | |
| `429 Too many requests` | A rate limit | `perIp` with `trustProxy` missing makes everyone share the proxy's limit |
| `503 Service unavailable` | The store, queue or site source failed | The log (`store.insertEvents`, `queue.send`, `sites.getSite`, ...) and `hooks.onError` |
| `202` with `rejected` entries | Some events were refused | Each entry's `errors`: an invalid field, an event name not allowed for the site, or an event that can't be sent without consent |

Every answer has an `X-Request-Id`; log entries carry the same ID.

## The banner shows for everyone

The region is unknown, so consent is required. Check `GET /v1/context`: `reason` is
`unknown-region`.

- No geo resolver is configured, or it returns nothing: a trusted header that your CDN doesn't
  actually set, a header name with a typo, IPinfo without a token.
- IPinfo sees a private address (`10.x`, `127.0.0.1`, ...): the client IP is the proxy's. Set
  [`trustProxy`](./node-and-fetch.md#client-ip).
- IPinfo fails (timeouts, quota): the log has a warning, at most once a minute.

## The banner never shows

The visitor's region doesn't require consent, or the site's `consentMode` is `never`. Check
`GET /v1/context` (`reason`: `region` or `site`), and which profile the data policy gives that
region.

## Events are stored as limited although the visitor accepted

- The visitor's decision is for another `policyVersion` (the site's changed): they count as
  undecided until they decide again.
- The events were sent before the decision (limited), and are stored as sent.
- A full event claiming no consent where consent is required is downgraded: `sanitized`
  contains `downgraded-to-limited`.

## Location or device data is missing from events

- The profile doesn't allow it for that category (limited events get at most country, region,
  ASN, parsed user agent and language).
- The geo resolver doesn't provide it (a country header gives only the country).
- `ip` needs the real client IP; `hashed` needs `hashSecret`.
- `strictDataPolicy()` adds nothing at all.

## Nothing reaches the store with a queue

- A worker is running, with the same queue and the same store.
- The worker logs (`message dead-lettered`, retries) and `worker.stats()`.
- SQS: the visibility timeout is long enough for a write; the region and credentials are those
  of the queue.
- Redis Streams: the same `stream` name on both sides.

## Mongoose: `MongoDB is not connected yet`

`mongoStore({ db: () => mongoose.connection.db })` was called before `mongoose.connect()`
finished. Requests in that window get `503` (and browsers retry). Run `ensureMongoIndexes`
after connecting.

## Startup errors

`createCollector` and the standalone collector validate their configuration:

- `SiteConfigError`: a site definition, with the field and the reason.
- `DataPolicyError`: every problem in a data policy, with its path (see
  [Rules a policy can't break](./data-policy.md#rules-a-policy-can-t-break)).
- `the data policy stores hashed IP addresses; set hashSecret`.
- `trustProxy`: an invalid address or CIDR range.
- The standalone collector lists every configuration problem at once; `--check` validates
  without starting.
