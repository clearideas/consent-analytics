---
title: Core concepts
description: 'Sites, consent policy, decisions and records, consent categories, full and limited events, data policies and the collector pipeline.'
---

# Core concepts

## Sites

A **site** is a website (or a group of them) registered with the collector:

| Setting | Meaning |
| --- | --- |
| `siteKey` | Public identifier the browser sends, e.g. `my-site`. Not a secret: it is in your page. |
| `allowedOrigins` | Exact origins allowed to use the key, e.g. `https://www.example.com`. Requests from other origins are refused (`403`), and CORS only admits these. |
| `policyVersion` | Version of your consent policy or banner. Change it when they change materially: visitors who decided under the old version are asked again. |
| `consentMode` | `geo` (default): consent is required depending on the visitor's region. `always` / `never`: regardless of region. |
| `trackingWithoutConsent` | Where consent is required and not given: `limited` (default) allows anonymous essential events, `none` allows nothing. |
| `credentials` | Allow cookies on requests from this site's origins, to identify signed-in visitors (off by default). |

See [Sites, origins and location](./server/sites-and-geo.md).

## The consent policy for a visitor

When a page loads, the library asks the collector `GET /v1/context?siteKey=…`. The answer
is this visitor's **policy**:

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

- The collector decides from the site's `consentMode` and, for `geo`, from the visitor's
  region through its [data policy](./server/data-policy.md).
- **Unknown means required.** If the region can't be determined, `consentRequired` is `true`
  (`reason: "unknown-region"`). If the browser can't reach the collector at all, the library
  also treats consent as required.
- The browser keeps the answer for the session (`ttlSeconds`, one hour by default), so
  further page loads don't ask again.

## Decisions

The visitor's **decision** is stored in their browser (`localStorage`), and applies
immediately. In the default **simple** mode, the banner asks one question: *Accept all* or
*Reject non-essential*. In **categories** mode, visitors can also choose per category:

| Category | Covers |
| --- | --- |
| necessary | The consent mechanism itself; functional tools. Always on. |
| preferences | Remembering settings and choices |
| statistics | Full first-party analytics, stored attribution, analytics tools (Google Analytics, Clarity, Hotjar) |
| marketing | Advertising tags and conversions (Google Ads, Microsoft UET, Meta Pixel, LinkedIn, ...) |

A decision is for one `policyVersion`. When you publish a new version, earlier decisions
no longer count and the banner appears again.

**Global Privacy Control** (a browser signal asking sites not to sell or share data)
withholds *marketing* where consent is not required, unless the visitor explicitly accepts.

## Consent records

Every decision is also sent to the collector as a **consent record** (`POST /v1/consent`):

```json
{
  "v": 1,
  "siteKey": "my-site",
  "consentId": "6b4e1c2f9a8d4e7fb3c5d1a2",
  "decision": "partial",
  "categories": { "preferences": false, "statistics": true, "marketing": false },
  "policyVersion": "2026-11-01",
  "decidedAt": "2026-11-10T12:00:04.000Z",
  "source": "banner"
}
```

- Records are **append-only**: changing your mind or withdrawing adds a new record with
  the same `consentId`, and earlier records stay as they were.
- Identical records (browser retries) are stored once: the collector derives the record ID
  from its contents.
- Records that can't be delivered are kept in the browser and retried on the next visit.

## Full and limited events

Each event the browser sends has a **tracking category**:

| | Sent when | Contains |
| --- | --- | --- |
| **full** | The visitor allowed statistics, or consent isn't required and they haven't refused | The event's props, page context, attribution, user agent, referrer |
| **limited** | Consent is required and statistics isn't allowed (undecided or refused), or the visitor refused where it isn't required | Only `page_view`, `page_exit`, `web_vital`, `auto_metrics` and `error`, with an allowlisted set of anonymous fields. URLs are reduced to origin and path. |

Where the policy says `trackingWithoutConsent: "none"`, nothing is sent until statistics is
allowed. Events such as `sign_up` or `purchase` are never sent as limited events: tracked
before the visitor allows statistics, they are discarded, not kept for later.

The collector checks this again: a "full" event without consent where consent is required
is stored as limited, and fields a limited event may not carry are removed (see
[Event rules](./server/rules.md)).

## Events

- **Automatic events**: `page_view`, `page_exit`, `scroll_depth`, `time_spent`,
  `outbound_link_click`, `web_vital` and `auto_metrics`.
- **Your events**: `trackEvent('sign_up', { plan: 'pro' })`. Names are normalized to
  `snake_case` (`"Newsletter Signup"` becomes `newsletter_signup`).
- **Errors**: `trackError(message, props)`.

Events are queued and sent in batches; essential events (`page_view`, `error`) go at once,
and everything queued goes when the page is hidden. See
[Events and delivery](./browser/events.md).

## Third-party tools

Google Analytics, Google Ads, Microsoft UET, Meta Pixel, HubSpot, Intercom, LinkedIn
Insight, Microsoft Clarity, Hotjar and others are **plugins**: configured by name, loaded
only when their category is allowed, told about consent changes, and stopped (with their
cookies deleted) on withdrawal. Tools without a plugin can be gated with
`<script type="text/plain" data-ci-consent="marketing">`. See
[Third-party tools](./browser/third-party.md).

## The collector

The collector implements three endpoints (plus `/v1/health`). For each request it:

1. checks the **origin** against the site's allowed origins (CORS);
2. **validates** the body against the contract (sizes, fields, formats), reporting invalid
   events one by one;
3. determines the visitor's **region** and selects the **data policy profile** for it;
4. applies the **event rules** (consent consistency, the limited allowlist, clock skew);
5. **enriches** the event with what the profile allows (IP address, location, network,
   parsed user agent, language, the signed-in visitor's identity);
6. **delivers** it to the store, directly, through an in-process buffer, or through a
   queue and a worker.

See [How the collector works](./server/concepts.md).

## Data policies and profiles

A **data policy** maps regions to **profiles**. A profile decides whether consent is
required there, what the collector may add to full and limited events, and how long
events, IP addresses and consent records are kept. The default `balanced` policy stores
everything useful with consent, and the minimum without it; the `strict` policy stores
only what the browser sends. See [Data policies](./server/data-policy.md).

## Glossary

| Term | Meaning |
| --- | --- |
| Collector | The server that implements the collector API and stores events and consent records |
| Context | The answer to `GET /v1/context`: the visitor's consent policy |
| Consent ID | A random ID the browser creates with a visitor's first decision; all of that visitor's later records share it |
| Record ID | The collector's ID for one consent record, derived from its contents |
| Session ID | A random ID per browser tab session; limited events use a separate anonymous one |
| Page view ID | Links the events of one page view (`page_view`, `page_exit`, `scroll_depth`, ...) |
| Profile | The part of the data policy that applies to a visitor's region |
| Enrichment | What the collector adds from the request (location, device, ...) under the profile |
| Identity | The signed-in visitor's IDs (e.g. `userId`, `accountId`), from your own authentication |
