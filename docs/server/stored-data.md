---
title: Stored data
description: 'The fields of stored events, consent records and identities, with examples, for querying your own data.'
---

# Stored data

Every store keeps the same records; only the layout differs (see [Stores](./storage.md)).
Times are ISO 8601 strings in UTC (MongoDB stores the server times as Dates).

## Events

A full event from Germany, with consent, from a signed-in visitor, under the `balanced`
policy:

```json
{
  "siteKey": "my-site",
  "eventId": "65f0a1b2c3d4e5f6a7b8c9d0",
  "name": "page_view",
  "occurredAt": "2026-11-10T12:00:00.000Z",
  "occurredAtCorrected": "2026-11-10T12:00:04.000Z",
  "sentAt": "2026-11-10T12:00:01.000Z",
  "receivedAt": "2026-11-10T12:00:05.000Z",
  "sessionId": "65f0a19ec3d4e5f6a7b8c9a1",
  "pageViewId": "65f0a1b0c3d4e5f6a7b8c9b2",
  "trackingCategory": "full",
  "consent": { "required": true, "granted": true },
  "props": {
    "url": "https://www.example.com/pricing?utm_source=newsletter",
    "path": "/pricing",
    "title": "Pricing",
    "referrer": "https://www.google.com/",
    "viewportBucket": "lg",
    "deviceBucket": "desktop",
    "userAgent": "Mozilla/5.0 (Macintosh; …) Chrome/130.0.0.0 Safari/537.36",
    "timezone": "Europe/Berlin",
    "language": "de-DE",
    "country": "DE",
    "continent": "EU",
    "utm_source": "newsletter",
    "attribution": {
      "utm_source": "newsletter",
      "utm_medium": "email",
      "landingPath": "/pricing",
      "landedAt": "2026-11-10T11:58:00.000Z"
    }
  },
  "page": {
    "url": "https://www.example.com/pricing?utm_source=newsletter",
    "path": "/pricing",
    "referrer": "https://www.google.com/",
    "viewportBucket": "lg",
    "deviceBucket": "desktop",
    "title": "Pricing"
  },
  "attribution": {
    "utm_source": "newsletter",
    "utm_medium": "email",
    "landingPath": "/pricing",
    "landedAt": "2026-11-10T11:58:00.000Z"
  },
  "client": {
    "userAgent": "Mozilla/5.0 (Macintosh; …) Chrome/130.0.0.0 Safari/537.36",
    "timezone": "Europe/Berlin",
    "language": "de-DE",
    "country": "DE",
    "continent": "EU"
  },
  "origin": "https://www.example.com",
  "profile": "gdpr",
  "server": {
    "ip": "81.2.69.142",
    "ipForm": "full",
    "geo": {
      "country": "DE",
      "continent": "EU",
      "region": "Berlin",
      "city": "Berlin",
      "timezone": "Europe/Berlin",
      "latitude": 52.52,
      "longitude": 13.4
    },
    "network": { "asn": "AS3320", "org": "Deutsche Telekom AG" },
    "userAgent": {
      "device": "desktop",
      "isBot": false,
      "browser": "Chrome",
      "browserVersion": "130",
      "os": "macOS",
      "osVersion": "10.15",
      "raw": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    },
    "language": "de-DE",
    "gpc": false
  },
  "identity": { "userId": "u-123", "accountId": "a-9" },
  "retainUntil": "2028-12-10T12:00:05.000Z",
  "ipRetainUntil": "2026-12-10T12:00:05.000Z",
  "rawUserAgentRetainUntil": "2026-12-10T12:00:05.000Z"
}
```

The same page as a limited event (no consent): the browser sent only allowlisted fields,
and the profile allows only the country, the device type and the language:

```json
{
  "siteKey": "my-site",
  "eventId": "65f0a1b2c3d4e5f6a7b8c9d1",
  "name": "page_view",
  "occurredAt": "2026-11-10T12:00:00.000Z",
  "occurredAtCorrected": "2026-11-10T12:00:04.000Z",
  "sentAt": "2026-11-10T12:00:01.000Z",
  "receivedAt": "2026-11-10T12:00:05.000Z",
  "sessionId": "anon_1762776000000_k3j9x2m1q",
  "pageViewId": "65f0a1b0c3d4e5f6a7b8c9b3",
  "trackingCategory": "limited",
  "consent": { "required": true, "granted": false },
  "props": { "url": "https://www.example.com/docs", "path": "/docs", "title": "Docs", "deviceBucket": "desktop" },
  "page": { "url": "https://www.example.com/docs", "path": "/docs", "deviceBucket": "desktop", "title": "Docs" },
  "origin": "https://www.example.com",
  "profile": "gdpr",
  "server": {
    "geo": { "country": "DE", "continent": "EU" },
    "userAgent": { "device": "desktop" },
    "language": "de-DE",
    "gpc": false
  },
  "retainUntil": "2028-12-10T12:00:05.000Z"
}
```

### Event fields

| Field | |
| --- | --- |
| `siteKey`, `eventId` | Unique together |
| `name` | The event name (`page_view`, `sign_up`, ...) |
| `occurredAt` | The browser's time (not trusted) |
| `occurredAtCorrected` | `occurredAt` corrected for the browser's clock skew, or `receivedAt` if implausible. **Use this for time series.** |
| `sentAt` | The browser's time when the batch was sent |
| `receivedAt` | The server's time when the batch arrived |
| `sessionId` | The tab session; limited events have a separate anonymous one (`anon_…`) |
| `pageViewId` | Links the events of one page view |
| `trackingCategory` | `full` or `limited` (after the [rules](./rules.md)) |
| `consent` | `{ required, granted }` as sent, after the rules |
| `props` | What the browser sent, after the rules |
| `origin` | The page's origin (the request's `Origin` header) |
| `profile` | The [data policy](./data-policy.md) profile applied |
| `server` | What the collector derived from the request, at the profile's levels (below) |
| `identity` | The signed-in visitor's identity keys (full events, where the profile allows) |
| `sanitized` | Repairs the rules made, e.g. `["downgraded-to-limited"]` (absent if none) |
| `retainUntil` | When the event expires |
| `ipRetainUntil`, `rawUserAgentRetainUntil` | When `server.ip` and `server.userAgent.raw` are removed |

### The projection

Browsers send some values under several names, and different events carry different
props. The collector adds a consistent, typed view of them, following the contract's event
catalog, so queries don't need to know each event's props:

| Field | From | Contents |
| --- | --- | --- |
| `page` | page context props | `url`, `path`, `referrer`, `title`, `viewportBucket`, `deviceBucket`, `connectionType` |
| `attribution` | `props.attribution` and top-level `utm_*`, `ci_*`, click IDs | the first-touch attribution |
| `client` | full events' context | `userAgent`, `timezone`, `language`, `country`, `continent` |
| `engagement` | `page_exit`, `time_spent`, `scroll_depth`, ... | `timeSpent` (seconds), `clicks`, `keypresses`, `maxScrollDepth`, `scrollDepth` |
| `vital` | `web_vital` | `{ name, value }` |
| `load` | `auto_metrics` | `phase` (`dom` or `load`) and the timings |
| `outbound` | `outbound_link_click` | `url`, `host`, `path`, `text` |
| `error` | `error` | `{ message }` |
| `propsTruncated` | | `true` when the browser dropped the props because they were too large |

### `server`

| Field | Profile setting | |
| --- | --- | --- |
| `ip`, `ipForm` | `ip` | The address, truncated (IPv4 /24, IPv6 /48) or hashed as the profile says; `ipForm` says which |
| `geo` | `geo` | `country`, `continent`, and with finer levels `region`, `regionCode`, `city`, `postalCode`, `timezone`, `latitude`, `longitude` |
| `network` | `network` | `asn`, and `org` at the `org` level |
| `userAgent` | `userAgent` | `device` (`desktop`, `mobile`, `tablet`, `bot`, ...); parsed: `browser`, `browserVersion`, `os`, `osVersion`, `isBot`; raw: `raw` |
| `language` | `language` | The primary language from `Accept-Language` |
| `gpc` | `gpc` | Whether the browser sent `Sec-GPC: 1` |
| `privacy` | `privacyFlags` | `vpn`, `proxy`, `tor`, `relay`, `hosting`, when the geo resolver knows them |

## Consent records

```json
{
  "recordId": "c272080eb13c7ac95359acb596ee24c8",
  "siteKey": "my-site",
  "consentId": "65f0a1b2c3d4e5f6a7b8c9e0",
  "decision": "granted",
  "categories": null,
  "policyVersion": "2026-11-01",
  "decidedAt": "2026-11-10T12:00:04.000Z",
  "recordedAt": "2026-11-10T12:00:05.000Z",
  "source": "banner",
  "origin": "https://www.example.com",
  "profile": "gdpr",
  "annotations": [],
  "identity": { "userId": "u-123", "accountId": "a-9" },
  "retainUntil": "2031-11-10T12:00:05.000Z"
}
```

| Field | |
| --- | --- |
| `recordId` | Derived from the record's contents (site, consent ID, time, decision, categories, policy version): identical retries share it |
| `consentId` | The browser's consent ID: all decisions of one visitor (in one browser) share it |
| `decision` | `granted`, `denied` or `partial` |
| `categories` | `{ preferences, statistics, marketing }` for choices per category, else `null` |
| `policyVersion` | The policy version the decision was made under |
| `decidedAt` | The browser's time of the decision (not trusted) |
| `recordedAt` | The server's time when it was stored |
| `source` | `banner` or `api` (your own UI) |
| `origin`, `profile` | As for events |
| `annotations` | Observations, e.g. `policy-version-not-current` (see [Event rules](./rules.md#consent-records)); the record itself is stored as received |
| `identity` | The signed-in visitor who decided, when known |
| `retainUntil` | When the record expires |

A visitor's current decision is their latest record by `recordedAt` (or `decidedAt`) for
their `consentId`.

## Identities

Traits of signed-in visitors, once per identity (only with `identity.traits` configured):

```json
{
  "siteKey": "my-site",
  "identity": { "userId": "u-123", "accountId": "a-9" },
  "traits": { "plan": "pro" },
  "seenAt": "2026-11-10T12:00:05.000Z"
}
```

The SQL stores also keep `first_seen_at`.
