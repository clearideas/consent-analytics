---
title: Collector API (v1)
description: 'The HTTP contract between the browser library and a collector, with examples, and a checklist for writing your own collector.'
---

# Collector API (v1)

The browser library talks to its collector through a documented HTTP contract:
[`spec/openapi.yaml`](https://github.com/clearideas/consent-analytics/blob/main/spec/openapi.yaml)
(OpenAPI 3.1, JSON Schema 2020-12). The spec is the normative document; this page summarizes
it, with examples.

You don't have to write a collector: the [collector library](./server/index.md) and the
[standalone collector](./server/collector.md) implement it. This page is for writing your own,
in another language or platform, and for understanding what travels over the wire.

The current version is **1.1**. Changes within v1 are additive: existing browsers and
collectors stay valid.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/context?siteKey=…` | The visitor's consent policy |
| `POST` | `/v1/events` | A batch of up to 50 events (at most 64 KiB). `202` with `accepted`, `duplicates` and per-event `rejected`. |
| `POST` | `/v1/consent` | An append-only consent record (at most 4 KiB). `201` with a `recordId`. |
| `GET` | `/v1/health` | Liveness (optional) |

The library calls `<apiBaseUrl>/v1/…`. Bodies are JSON, sent as `text/plain;charset=UTF-8` so
that browsers need no CORS preflight; collectors accept `application/json` too.

### `GET /v1/context`

```http
GET /v1/context?siteKey=my-site
Origin: https://www.example.com
```

```json
{
  "v": 1,
  "siteKey": "my-site",
  "policy": {
    "consentRequired": true,
    "policyVersion": "2026-11-01",
    "trackingWithoutConsent": "limited",
    "reason": "region"
  },
  "geo": { "country": "DE", "continent": "EU" },
  "ttlSeconds": 3600
}
```

`reason` is `region`, `site` (the site's own setting) or `unknown-region`. `geo` is optional
and coarse. The response is `Cache-Control: private, no-store`; the browser keeps it for its
session, up to `ttlSeconds`.

### `POST /v1/events`

```json
{
  "v": 1,
  "siteKey": "my-site",
  "sentAt": "2026-11-10T12:00:01.000Z",
  "events": [
    {
      "eventId": "65f0a1b2c3d4e5f6a7b8c9d0",
      "name": "page_view",
      "occurredAt": "2026-11-10T12:00:00.000Z",
      "sessionId": "65f0a19ec3d4e5f6a7b8c9a1",
      "pageViewId": "65f0a1b0c3d4e5f6a7b8c9b2",
      "trackingCategory": "limited",
      "consent": { "required": true, "granted": false },
      "props": { "url": "https://www.example.com/pricing", "path": "/pricing" }
    }
  ]
}
```

```json
{ "accepted": 1, "duplicates": 0, "rejected": [] }
```

Invalid events are reported one by one, and the rest of the batch is stored:

```json
{
  "accepted": 1,
  "duplicates": 0,
  "rejected": [
    { "index": 1, "eventId": "…", "errors": [{ "path": "/name", "message": "must match pattern \"^[a-z][a-z0-9_]{0,63}$\"" }] }
  ]
}
```

### `POST /v1/consent`

```json
{
  "v": 1,
  "siteKey": "my-site",
  "consentId": "65f0a1b2c3d4e5f6a7b8c9e0",
  "decision": "partial",
  "categories": { "preferences": false, "statistics": true, "marketing": false },
  "policyVersion": "2026-11-01",
  "decidedAt": "2026-11-10T12:00:04.000Z",
  "source": "banner"
}
```

```json
{ "recordId": "c272080eb13c7ac95359acb596ee24c8", "consentId": "65f0a1b2c3d4e5f6a7b8c9e0", "recordedAt": "2026-11-10T12:00:05.000Z" }
```

### Errors

Problem details (`application/problem+json`):

```json
{ "type": "about:blank", "title": "Origin not allowed", "status": 403 }
```

| Status | When |
| --- | --- |
| `400` | Malformed JSON, or an invalid envelope or record (`errors` lists the fields) |
| `403` | The origin isn't allowed for the site |
| `404` | Unknown site key, or an unknown path |
| `413` | The body is too large |
| `415` | Not `text/plain` or `application/json` |
| `429` | Rate limited, with `Retry-After` |
| `503` | Storage temporarily unavailable, with `Retry-After`; clients retry |

## Implementer checklist

- **Site keys and origins.** Register each site with a public `siteKey` and the exact origins
  allowed to use it. Refuse other origins with `403`. Require `Origin` on `POST` (browsers
  always send it, also with `sendBeacon`).
- **CORS.** Echo `Access-Control-Allow-Origin` for allowed origins on every response, errors
  included, with `Vary: Origin`. Answer `OPTIONS` with `204`. Send
  `Access-Control-Allow-Credentials: true` only for sites that enable credentialed requests,
  with their exact origins, never with `*`.
- **Bodies.** Accept JSON as `text/plain` and `application/json`. Enforce the 64 KiB
  (events) and 4 KiB (consent) limits with `413`, while reading, not only from
  `Content-Length`.
- **Validation.** Validate against the spec's schemas. Report invalid events one by one and
  store the rest.
- **Idempotency.** Store each `(siteKey, eventId)` once. Treat an identical consent record
  (same `siteKey`, `consentId`, `decidedAt`, `decision`, `categories` and `policyVersion`) as
  the same record, with the same `recordId`.
- **Consent policy.** Determine the visitor's region however you like (a CDN header, an IP
  lookup). **Unknown region means consent is required.** Trust a CDN header only if clients
  can't reach you without it.
- **Tracking without consent.** Return `policy.trackingWithoutConsent: "none"` for regions where
  even anonymous measurement needs consent; browsers then send nothing until statistics is
  allowed.
- **Limited events.** Keep them anonymous: don't join them with persistent identifiers or
  with full events, and don't store IP addresses (in any form) or identities with them.
  `x-limited-tracking` in the spec lists what they may contain.
- **Consent records.** Store them as received, append-only, with their `categories`. Don't
  add IP addresses to them. Identify visitors by cookies only for sites with credentialed
  requests.
- **Retries.** Answer `503` with `Retry-After` when storage is temporarily unavailable.
  Asynchronous storage (queues) is allowed: `202`/`201` then mean *accepted for storage*, and
  `duplicates` may be `0`.
- **Outside the contract:** authentication for your read and admin APIs, rate limiting,
  retention, access control.

## Checking an implementation

- `collector/scripts/smoke.mjs <url> [siteKey] [origin]` checks a running collector: health,
  readiness, the context, CORS for a foreign origin, a consent record and its retry, and an
  event batch.
- The repository's contract tests (`server/test/contract.test.ts`) show the expected
  behavior for each rule, and validate every response against the schema the spec declares
  for its status.
- Point the [playground](./playground.md)'s scenarios at your implementation to see the
  browser side.

## Changes from the pre-v1 endpoints

| Before | v1 |
| --- | --- |
| `GET /event/geo` and `GET /event/consent/status` | One `GET /v1/context`. The decision is stored in the browser; the server no longer returns it. |
| `POST /event/consent/update` | `POST /v1/consent`: an append-only record with `consentId`, `policyVersion`, `decidedAt`, `source` |
| `GET /event/session` (returned a `userId`) | Removed |
| `POST /event` with a bare array | `POST /v1/events` with an envelope `{ v, siteKey, sentAt, events }` |
| `credentials: 'include'` (cookies) | No credentials by default; opt-in credentialed requests per site (1.1) |
| Site identified by `eventSiteName` in each event | `siteKey` in the envelope and query, checked against allowed origins |

## Version history

- **1.1** (additive): `503` with `Retry-After`; asynchronous storage; de-duplicated consent
  records; optional credentialed requests; the event catalog (`x-event-catalog`) and
  `x-limited-tracking`; the `INP` web vital.
- **1.0**: the first versioned contract.
