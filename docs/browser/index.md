---
title: Browser library
description: 'What @clearideas/consent-analytics does in the browser, its entry points and requirements.'
---

# Browser library

`@clearideas/consent-analytics` runs on your website. It:

- asks the collector whether this visitor must consent, and shows an accessible **consent
  banner** where they must (or use your own UI through the consent API);
- tracks **page views** (also in single-page apps), page exits with engagement, scroll
  depth, outbound links, web vitals, errors and **your own events**;
- sends only anonymous **limited** events until the visitor allows statistics;
- keeps first-touch **attribution** (campaign parameters and ad click IDs) once allowed,
  and fires Google Ads and Microsoft Ads conversions for traffic from those ads;
- loads **third-party tools** (Google Analytics, Meta Pixel, HubSpot, ...) only when their
  consent category is allowed, and removes them and their cookies on withdrawal;
- records each decision as a **consent record** on the collector.

It has no runtime dependencies and sets no cookies unless you configure one. The npm entry
points put nothing on `window` unless asked; the script-tag build adds
`window.ClearIdeasAnalytics`.

::: tip Versions
These docs follow the `main` branch. Features listed under *Unreleased* in the
[changelog](https://github.com/clearideas/consent-analytics/blob/main/CHANGELOG.md)
(consent categories, the settings link, the plugin directory, gated scripts, the
`credentials` option, ...) are not in `0.1.1`, the current release on npm.
:::

## Entry points

| Import | For |
| --- | --- |
| `dist/analytics.js` (script tag) | Any website, no build tools. Exposes `window.ClearIdeasAnalytics`. |
| `@clearideas/consent-analytics/browser` | Any framework; page changes from the History API. |
| `@clearideas/consent-analytics/react` | React: `AnalyticsProvider`, `useAnalytics()`, `useConsent()`. |
| `@clearideas/consent-analytics/next` | Next.js App Router: `<ClearIdeasAnalytics>`. |
| `@clearideas/consent-analytics/nuxt.client` | Nuxt plugin, configured from `runtimeConfig.public`. |
| `@clearideas/consent-analytics/vite` | Vue + Vite apps: `initViteAnalytics(router)`, configured from `VITE_*` variables. |
| `@clearideas/consent-analytics/plugins` | Built-in plugin factories and types, for code-level use. |
| `@clearideas/consent-analytics/consent.css` | The banner's stylesheet, for pages with a strict Content Security Policy. |
| `@clearideas/consent-analytics` | The core: `initAnalytics(config, adapter)` for your own framework adapter, and helpers. |

See [Add it to your site](./frameworks.md) for each one.

## Requirements

- A collector that implements the [collector API](../api-contract.md): the
  [collector library](../server/index.md), the [standalone collector](../server/collector.md),
  or your own.
- Browsers with ES2020 support (all current browsers). The script-tag build is about 55 KB
  minified (19 KB gzipped); each third-party plugin is a separate file, downloaded only when
  configured and allowed.
- Optional peer dependencies, only for their integrations: `react` 18 or newer, `next` 13.4
  or newer, `nuxt` 3 or 4.

## Minimal setup

Every integration needs two settings: the collector's address and your site key.

```html
<script
  async
  src="https://cdn.jsdelivr.net/npm/@clearideas/consent-analytics@X.Y.Z/dist/analytics.js"
  data-api-base-url="https://collector.example.com/"
  data-site-key="my-site"
></script>
```

```ts
import { initBrowserAnalytics } from '@clearideas/consent-analytics/browser'

const analytics = initBrowserAnalytics({
  apiBaseUrl: 'https://collector.example.com/',
  siteKey: 'my-site',
})
analytics.trackEvent('sign_up', { plan: 'pro' })
```

Everything else is optional: see the [configuration reference](./configuration.md).

## In this section

- [Add it to your site](./frameworks.md): script tag, React, Next.js, Vue, Nuxt, SvelteKit,
  Angular, Astro.
- [Consent and the banner](./consent.md): the consent model, banner options, categories,
  the headless API, Global Privacy Control.
- [Events and delivery](./events.md): automatic events, your events, full and limited,
  batching and retries, web vitals.
- [Attribution and conversions](./attribution.md)
- [Third-party tools](./third-party.md): plugins, gated scripts, withdrawal.
- [Signed-in visitors](./identity.md)
- [Privacy and security](./privacy-security.md): storage and cookies, what leaves the page,
  Content Security Policy.
- [Configuration](./configuration.md) and [API](./api.md) reference.
- [Troubleshooting](./troubleshooting.md)
