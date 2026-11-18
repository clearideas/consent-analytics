---
title: Events and delivery
description: 'The events the library sends automatically, your own events, full and limited events, web vitals, and how events are batched and delivered.'
---

# Events and delivery

## Automatic events

| Event | When | Props |
| --- | --- | --- |
| `page_view` | On load, and on each page change in a single-page app | Page context: `url`, `path`, `referrer`, `title`, `viewportBucket`, `deviceBucket`, `connectionType` |
| `page_exit` | Leaving a page: a page change, the tab hidden, or the page unloaded | The page left, with `timeSpent` (seconds), `clicks`, `keypresses`, `maxScrollDepth` |
| `scroll_depth` | A new maximum scroll depth of 25% or more, measured shortly after scrolling stops | `depth` (percent), `path` |
| `time_spent` | The page is hidden after 30 seconds or more on it | `duration` and `timeSpent` (seconds), engagement, page context |
| `outbound_link_click` | A click on a link to another origin | `outboundUrl` (without query or fragment), `outboundHost`, `outboundPath`, `outboundText`, page context |
| `web_vital` | See [Web vitals](#web-vitals) | `name`, `value`, page context |
| `auto_metrics` | At DOM ready, and again after `load` | DOM ready: navigation timings and resource totals; after load: `fullyLoadedTime`, `pageLoadTime` |

Turn off the optional ones with `autoTrackScrollDepth`, `autoTrackTimeSpent` and
`autoTrackOutboundLinks` (all `true` by default). `analytics.stopAutoTracking()` removes all
automatic tracking; `startAutoTracking()` starts it again.

Events of one page view share a `pageViewId`; events of one tab session share a
`sessionId`.

## Your events

```ts
analytics.trackEvent('sign_up', { plan: 'pro', method: 'email' })
analytics.trackEvent('purchase', { value: 99, currency: 'USD' })
analytics.trackError('Checkout failed', { code: 'E_PAYMENT' })
```

- **Names** must match `^[a-z][a-z0-9_]{0,63}$`. Others are normalized:
  `"Newsletter Signup"` becomes `newsletter_signup`, `"404 seen"` becomes `event_404_seen`.
- **Props** are JSON values. They are fitted to the contract's limits before sending:
  at most 100 top-level and 50 nested keys, 50 array items, 6 levels deep, strings up to 2,048
  characters; `Date` values become ISO strings, and functions and `undefined` are dropped.
  An event whose props are still larger than 32 KB is sent with `{ propsTruncated: true }`
  instead.
- Your props object is never modified.
- `url` and `referrer` props are [sanitized](./privacy-security.md#what-leaves-the-page)
  like page URLs.

::: tip Naming
Use `snake_case` verbs in the past or present tense (`sign_up`, `purchase`,
`newsletter_signup`), and the same name in every place that means the same thing. Some
third-party plugins map names to the vendor's standard events (for example
[OpenAI Ads](./attribution.md#openai-ads)).
:::

## Full and limited events

Each event is sent as **full** or **limited**:

- **full** when the visitor allowed statistics, or consent isn't required and they haven't
  refused. Full events carry your props plus the browser context: `userAgent`, `referrer`,
  `title`, `viewportBucket`, `deviceBucket`, `connectionType`, `timezone`, `language`, the
  `country` and `continent` from the collector's answer, and first-touch
  [attribution](./attribution.md) in `props.attribution` (with `utm_*`, `ci_*`, `gclid` and
  `msclkid` repeated at the top level).
- **limited** otherwise. Only `page_view`, `page_exit`, `web_vital`, `auto_metrics` and
  `error` are sent, with only these props: page `path`, `url` and `title`, campaign
  parameters and click IDs **only if you put them in props yourself**, engagement counts,
  `viewportBucket`, `deviceBucket`, `connectionType`, the error `message` (up to 500
  characters), the web vital `name` and `value`, `timezone`, `language`, `country` and
  `continent`. URLs are reduced to origin and path. The session ID is a separate,
  anonymous per-tab ID.

Other events (`sign_up`, `purchase`, ...) aren't sent as limited events: tracked before the
visitor allows statistics, they are discarded. Where the policy is
`trackingWithoutConsent: "none"`, nothing at all is sent until statistics is allowed.

The exact lists are in the contract (`x-limited-tracking` in
[`spec/openapi.yaml`](https://github.com/clearideas/consent-analytics/blob/main/spec/openapi.yaml));
the collector enforces the same lists.

## Web vitals

The library measures the page's web vitals with the browser's Performance APIs. Each is
a `web_vital` event with `name` and `value`:

| Name | Measures | Unit | Sent |
| --- | --- | --- | --- |
| `LCP` | Largest Contentful Paint: when the main content appeared | ms | once, when the page is first hidden (its final value) |
| `INP` | Interaction to Next Paint: the slowest interaction, ignoring one in fifty as an outlier | ms | when the page is hidden, again if it changed |
| `CLS` | Cumulative Layout Shift: the largest burst of unexpected layout shifts (session windows) | unitless | when the page is hidden, again if it changed |
| `FCP` | First Contentful Paint | ms | once, when measured |
| `TTFB` | Time to First Byte, from navigation start | ms | once, when measured |
| `FID` | First Input Delay (replaced by INP as a Core Web Vital) | ms | once, after the first interaction |

- Measurements made before the library started (such as FCP and TTFB) are included.
- They describe the document: in a single-page app, `LCP`, `FCP` and `TTFB` belong to the
  page the visitor landed on; `CLS` and `INP` cover the whole visit up to when the page is
  hidden.
- Layout shifts within half a second of the visitor's input don't count towards CLS.
- Browsers that don't support a measurement don't send it.

## Delivery

1. **Queueing.** Events are queued in memory and in `sessionStorage` (`ci_events_queue`),
   so a reload in the same tab doesn't lose them.
2. **Sending.** The queue is sent:
   - at once for essential events (`page_view`, `error`);
   - when `batchSize` events (default 10) are queued;
   - every `flushInterval` (default 60 seconds);
   - when the page is hidden (tab switched, window minimized, page closed or navigated away);
   - when you call `analytics.flush()`.
3. **Batches.** Each request (`POST /v1/events`) holds at most 50 events and 60 KB, as
   `text/plain` JSON, which needs no CORS preflight.
4. **Transport.** Batches go with `navigator.sendBeacon`, which the browser delivers even
   while the page closes. If it's unavailable or refuses (a quota), they go with `fetch`
   (`keepalive`), and failures (network errors, `408`, `429`, `5xx`) are retried up to
   `maxRetries` times (default 2), at the following sends. Other `4xx` answers are final.
5. **Duplicates.** Each event has an `eventId`; the collector stores each one once, so
   retries are safe.

The page can't read the answer to a beacon: a batch the collector refuses, or can't store
(`503`), is not retried. If your collector is often unavailable, prefer a delivery mode that
answers quickly (see [Delivery and queues](../server/delivery.md)).

**Consent records** go separately, with `fetch` (`POST /v1/consent`), as soon as a decision is
made. Records that fail are kept in `localStorage` (`ci_consent_pending`, up to 10) and sent
again on the next page load.

**Context.** `GET /v1/context` is requested once per browser session (cached for the
collector's `ttlSeconds`), with a 5-second timeout. On failure, consent is required.

## Owner tracking

To keep your own visits out of the data, turn tracking off in your browser:

```ts
import { setDontTrackOwner } from '@clearideas/consent-analytics'
setDontTrackOwner(true)
```

Or, with `exposeGlobals` or `debug` on, from the console: `ciAnalytics.disableOwnerTracking()`
(and `enableOwnerTracking()`, `ownerTrackingStatus()`). The setting is stored in this
browser's `localStorage` (`ci_dont_track_owner`).
