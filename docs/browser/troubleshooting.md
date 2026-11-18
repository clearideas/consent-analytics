---
title: Troubleshooting the browser library
description: 'Debug logging, and what to check when events don''t arrive, the banner doesn''t show, or integrations don''t load.'
---

# Troubleshooting

## Turn on debug logging

```ts
initBrowserAnalytics({ apiBaseUrl, siteKey, debug: true })
```

Script tag: `data-debug="true"`. Nuxt: `analyticsDebug: true`. Vite:
`VITE_ANALYTICS_DEBUG=true`. On a live site, without changing the configuration: with
`exposeGlobals` on, run `ciAnalytics.enableDebug()` in the console (for this browser
session).

The console then shows `🔍 [Analytics] …` lines: the context, the consent state, each event
and why it was sent, limited or skipped, each batch, and the integrations.

## No events arrive at the collector

Check the browser's **Network** tab for `/v1/context` and `/v1/events`.

| What you see | Likely cause |
| --- | --- |
| No requests at all | The library didn't start: `apiBaseUrl` or `siteKey` missing (the console says so for the script tag), the script blocked by a Content Security Policy or an ad blocker, or `data-auto-init="false"`. |
| `403` with `Origin not allowed` | The page's origin isn't in the site's `allowedOrigins`. Origins are exact: scheme, host and port (`https://www.example.com` and `https://example.com` are different). |
| `404` with `Unknown site key` | The `siteKey` isn't registered on the collector, or has a typo. |
| A CORS error in the console, no status | The request didn't reach the collector, or came back without CORS headers: wrong `apiBaseUrl`, the collector down, or a proxy in front of it answering instead. |
| `GET /v1/context` works, but no `/v1/events` | Non-essential events are batched: wait for the `flushInterval` (60 s by default), switch tabs, or call `analytics.flush()`. |
| Events are sent, but only some | Before consent, only limited events are sent (`page_view`, `page_exit`, `web_vital`, `auto_metrics`, `error`); others are discarded. Where the policy is `trackingWithoutConsent: "none"`, nothing is sent before consent. |
| `/v1/events` answers `202` with `rejected` entries | The collector refused individual events; the answer says which field, for example an event name not allowed for the site. |
| Events from your own browser are missing | Owner tracking is off in your browser (`ci_dont_track_owner` in `localStorage`). |

Beacons (`sendBeacon`) show in the Network tab as `ping` requests. Their answers aren't
available to the page.

## The banner doesn't show

- **Consent isn't required for this visitor.** Check the `GET /v1/context` answer:
  `policy.consentRequired`. It's decided by the collector from the visitor's region. While
  testing, use your collector's development setting (for example `DEFAULT_COUNTRY=DE` on the
  standalone collector).
- **The visitor already decided** for this policy version. Clear `ci_consent_status` in
  `localStorage`, or publish a new `policyVersion`.
- **The context is cached** for the browser session. After changing the collector's policy,
  open a new tab, or remove `ci_geo_context` from `sessionStorage`.
- `banner: false` or `banner: { autoShow: false }` is set.
- The banner is there, but hidden by your styles: check `z-index` (`--ci-consent-z-index`) and
  a CSP that blocks its injected styles (see
  [Content Security Policy](./privacy-security.md#content-security-policy)).

## Consent records aren't stored

- They're sent with `fetch`, so the answer is visible in the Network tab
  (`POST /v1/consent`, `201` expected).
- Failed records are kept in `localStorage` (`ci_consent_pending`) and sent again on the next
  page load.

## An integration doesn't load

- Its category isn't allowed yet. Plugins load only after the visitor accepts their category,
  or where consent isn't required. Marketing tools also wait when the browser sends Global
  Privacy Control.
- The vendor ID is invalid: IDs are checked against the vendor's format, and an invalid one
  disables the plugin (the console warns: `… is missing or invalid; the integration is not loaded`).
- A Content Security Policy blocks the vendor's script. With the script-tag build, a plugin
  file whose integrity check fails is refused.
- A snippet for the same tool is also in your HTML: remove it, or the tool runs regardless of
  consent (and may run twice).

## Page views are missing or counted twice

- **Missing in a single-page app:** the router doesn't use the History API, or you use
  `routeChanges: 'manual'` without calling `notifyRouteChange()`.
- **Twice:** two instances were started (for example the script tag and an npm import), or
  your code also tracks `page_view` itself. `page_view` is automatic.
- URL changes that only add or remove a `#fragment`, or the library's own removal of
  campaign parameters, aren't page changes.

## Nuxt: "useRuntimeConfig is not defined"

Not needed with Nuxt 4. On older versions, add `@clearideas/consent-analytics` to
`build.transpile` in `nuxt.config.ts`.

## npm reports 404 for the package

Check that your registry is `https://registry.npmjs.org/`. An organization-level `.npmrc`
may redirect the `@clearideas` scope to a private registry.

## Still stuck

Reproduce it in the [playground](../playground.md), which shows every request and stored
record, and [open an issue](https://github.com/clearideas/consent-analytics/issues) with
what you expected and what you saw.
