---
title: Privacy and security
description: 'What the library stores in the browser, what leaves the page, Content Security Policy, Subresource Integrity and other safeguards.'
---

# Privacy and security

## What the library stores in the browser

Use this table for your cookie or privacy notice. Everything is first-party (your site's
own storage); keys start with `ci_`.

| Key | Where | Set | Contents | Kept |
| --- | --- | --- | --- | --- |
| `ci_consent_status` | localStorage | when the visitor decides | the decision, per category, with the policy version, the consent ID and the time | until changed or cleared |
| `ci_consent_pending` | localStorage | when a consent record couldn't be delivered | up to 10 records waiting to be sent | until delivered |
| `ci_geo_context` | sessionStorage | on page load | the collector's answer: consent required, policy version, country and continent | the tab session (at most the collector's `ttlSeconds`) |
| `ci_events_queue` | sessionStorage | when events are queued | events not yet sent | the tab session |
| `ci_user_session` | sessionStorage | with the first event | a random session ID, sent with `full` events only | the tab session |
| `ci_anon_session` | sessionStorage | with the first `limited` event | a separate random ID, sent with `limited` events only | the tab session |
| `ci_click` | localStorage | when statistics is allowed | first-touch [attribution](./attribution.md) | until statistics is refused or withdrawn |
| `ci_click` | cookie, on `cookieDomain` | when statistics is allowed, only if `cookieDomain` is set | the same attribution, shared with subdomains | 90 days; deleted on refusal or withdrawal |
| `ci_dont_track_owner` | localStorage | only if you turn [owner tracking](./events.md#owner-tracking) off | `true` | until turned back on |

Before a decision, where consent is required, the library keeps only what it needs to work
and to send anonymous events: the collector's answer, the event queue and the random
per-tab session IDs, all in `sessionStorage`, which the browser clears when the tab closes.
Nothing persistent is stored until the visitor decides.

Without `cookieDomain`, the library sets **no cookies**. Third-party tools set their own
once allowed; those the library knows are deleted on refusal and withdrawal (see
[Third-party tools](./third-party.md#what-refusal-and-withdrawal-do)).

## What leaves the page

- **Page URLs** are reduced to origin, path and campaign parameters (`utm_source`,
  `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` and the `ci_*` equivalents).
  Other query parameters (reset tokens, emails, session IDs, search terms, click IDs) and
  `#fragments` are removed, for your collector and for third parties alike. Keep
  site-specific parameters with `urlQueryAllowlist`.
- **Referrers** are reduced to origin and path.
- **Before consent** (where it's required), URLs are origin and path only, and events carry
  only an [allowlisted, anonymous set of fields](./events.md#full-and-limited-events).
- **No fingerprinting data:** screen and viewport sizes are sent as coarse buckets
  (`xs` to `xl`, `mobile`/`tablet`/`desktop`), not exact values. No canvas, font or
  hardware probing.
- **Consent records** carry the decision, the policy version, the time, the source and a
  random consent ID. No IP address or cookie is added by the library.
- **Google Analytics** and other plugins receive each event's own parameters. Attribution,
  click IDs and the library's control keys (`ads_send_to`, `force_ads_conversion`,
  `goal_id`, ...) are not forwarded.
- **Requests to the collector** carry no cookies unless you set
  [`credentials`](./identity.md). The one exception is `sendBeacon`, which browsers always
  send with cookies; the collector ignores them for sites without `credentials: true`.
- **Vendor scripts** read the page themselves once they run. The URL sanitization applies
  to what this library sends, not to what a vendor's script collects.

Like any request, requests to the collector reveal the visitor's IP address and user
agent to it. What the collector keeps of them is decided by its
[data policy](../server/data-policy.md).

## Content Security Policy

A policy that works with the library:

```http
Content-Security-Policy:
  script-src 'nonce-{random}' 'strict-dynamic';
  connect-src 'self' https://collector.example.com;
  style-src 'self';
  object-src 'none'; base-uri 'none'
```

- **Scripts.** Put the nonce on the library's `<script>` tag. With `'strict-dynamic'`,
  plugin files and vendor scripts the library loads are trusted through it. Without
  `'strict-dynamic'`, allow the library's origin and each vendor's script origin in
  `script-src`.
- **Collector.** Allow your collector's origin in `connect-src` (the context, events and
  consent records).
- **Styles.** The banner injects a `<style>` element by default. Without
  `'unsafe-inline'` in `style-src`, set `banner: { injectStyles: false }` and include
  `@clearideas/consent-analytics/consent.css` (or `dist/consent.css`) as a stylesheet.
- **Consent-gated scripts** must carry the page's nonce to be activated; see
  [Consent-gated scripts](./third-party.md#content-security-policy). The library never
  starts an inert script that might be injected markup.
- Vendor tools may need more (frames, images, connections to their servers); see their
  documentation.

## Integrity of the code you load

- **Pin versions** and use Subresource Integrity for the script tag
  (`integrity="sha384-…" crossorigin="anonymous"`).
- **Plugin files** of the script-tag build are checked against hashes built into
  `analytics.js`: pinning it pins them. A modified plugin file is refused and that plugin
  doesn't run; the rest keeps working.
- **Vendor IDs** from your configuration are validated against each vendor's format before
  they're used in script URLs.
- **Configured texts** (banner title, message, labels) are rendered as text, never as HTML.
- **Nothing on `window`** unless you ask: `ClearIdeasAnalytics` with the script tag, and
  `ciAnalytics` console helpers only with `exposeGlobals` or `debug`. The library never
  writes `window.analytics`, so it can coexist with Segment and similar tools.

## What to put in your privacy notice

The library can't write your notice, but it gives you the facts it needs:

- the storage table above;
- the [third-party tools](./third-party.md) you enabled, their categories and cookies;
- what your collector stores per region (your [data policy](../server/data-policy.md)) and
  for how long;
- that visitors can change their decision at any time (your *Cookie settings* link).

## Reporting a vulnerability

See [SECURITY.md](https://github.com/clearideas/consent-analytics/blob/main/SECURITY.md).
Please report privately.
