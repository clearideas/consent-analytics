---
title: Browser configuration
description: 'Every option of the browser library, with its default and its name in the script tag, Nuxt and Vite.'
---

# Browser configuration

Options are given as an object (`initBrowserAnalytics(config)`, `<AnalyticsProvider config>`,
`window.ciAnalyticsConfig`), as Nuxt public runtime config, or as Vite environment
variables. Only `apiBaseUrl` and `siteKey` are required.

## Options

### Collector

| Option | Type | Default | |
| --- | --- | --- | --- |
| `apiBaseUrl` | string | required | The collector's base URL. The library calls `<apiBaseUrl>/v1/context`, `/v1/events` and `/v1/consent`. A path works: `https://api.example.com/analytics`. |
| `siteKey` | string | required | The site key registered with the collector (3 to 64 of `A-Z a-z 0-9 . _ -`). |
| `credentials` | `'omit'` \| `'same-origin'` \| `'include'` | `'omit'` | Send cookies to the collector, to [identify signed-in visitors](./identity.md). |
| `initialContext` | object | none | The consent policy supplied with the page (server rendering, edge functions): `{ consentRequired, policyVersion?, trackingWithoutConsent?, country?, continent? }`. Skips `GET /v1/context`. |

### Consent

| Option | Type | Default | |
| --- | --- | --- | --- |
| `banner` | object \| `false` | see below | The built-in banner's texts and behavior; `false` for your own UI. |
| `consent.choices` | `'simple'` \| `'categories'` | `'simple'` | One choice (accept or reject), or choices per category with a *Customize* view. |
| `consent.categories` | array | all three | Categories offered in `categories` mode: `preferences`, `statistics`, `marketing`. |
| `consent.trackingWithoutConsent` | `'limited'` \| `'none'` | `'limited'` | Where consent is required and statistics isn't allowed: anonymous essential events, or nothing. The collector's per-region answer takes precedence. |
| `consent.reloadOnWithdrawal` | boolean | `true` | Reload the page once after a withdrawal, when a running third-party tool can't be stopped in place. |
| `respectGlobalPrivacyControl` | boolean | `true` | Withhold *marketing* from browsers that send Global Privacy Control, where consent isn't required, unless the visitor accepts. |
| `websiteBaseUrl` | string | none | Your site's base URL. The banner's privacy link defaults to `<websiteBaseUrl>privacy` (else `/privacy`). |

`banner` options (all optional):

| Option | Default |
| --- | --- |
| `title` | `Help us improve your experience` |
| `message` | `We use cookies and similar technologies to keep our site secure, operate essential features, analyze traffic, and improve content and advertising. Choose "Accept all" to allow all of them, or "Reject non-essential" to allow only those the site needs to work.` |
| `acceptLabel` | `Accept all` |
| `rejectLabel` | `Reject non-essential` |
| `privacyPolicyUrl` | `<websiteBaseUrl>privacy`, or `/privacy` (http and https URLs only) |
| `privacyLinkLabel` | `Privacy policy` |
| `position` | `'bottom'` (or `'top'`) |
| `autoShow` | `true`: shown to undecided visitors on load. `false`: only when you call `consent.showBanner()`. |
| `injectStyles` | `true`. `false`: style it yourself, or import `@clearideas/consent-analytics/consent.css`. |
| `manageButton` | `'auto'`: a floating *Cookie settings* button once the visitor has decided, where consent is required, unless the page has its own settings link. `true`: always. `false`: never. |
| `manageLabel` | `Cookie settings` |
| `customizeLabel` | `Customize` (categories mode) |
| `saveLabel` | `Save choices` (categories mode) |
| `categoriesLegend` | `Choose which cookies to allow` (categories mode) |
| `categoryText` | Label and description per category, e.g. `{ statistics: { label: 'Analytics', description: '…' } }` |

See [Consent and the banner](./consent.md).

### Tracking

| Option | Type | Default | |
| --- | --- | --- | --- |
| `autoTrackScrollDepth` | boolean | `true` | `scroll_depth` at each new maximum of 25% or more. |
| `autoTrackTimeSpent` | boolean | `true` | `time_spent` when the page is hidden after 30 seconds or more. |
| `autoTrackOutboundLinks` | boolean | `true` | `outbound_link_click` for links to other origins. |
| `flushInterval` | number (ms) | `60000` | How often queued events are sent. Essential events go at once, and everything goes when the page is hidden. |
| `batchSize` | number | `10` | Send when this many events are queued. |
| `maxRetries` | number | `2` | Retries for a batch that failed (network errors, `408`, `429`, `5xx`). |
| `urlQueryAllowlist` | string[] | `[]` | Extra query parameters kept in page URLs. Campaign parameters (`utm_*`, `ci_*`) are always kept; everything else is removed. |
| `cleanAttributionUrl` | boolean | `true` | Remove campaign parameters and click IDs from the address bar once captured. |
| `cookieDomain` | string | none | Share attribution across subdomains in a 90-day first-party cookie on this domain (e.g. `example.com`). Without it, no cookie is set. |

### Integrations

| Option | Type | Default | |
| --- | --- | --- | --- |
| `integrations` | object | none | Built-in third-party tools by name, e.g. `{ googleAnalytics: { measurementId: 'G-…' } }`. `false` disables one. See [Third-party tools](./third-party.md). |
| `plugins` | `AnalyticsPlugin[]` | none | Your own plugins. |
| `gatedScripts` | object \| `false` | on | Consent-gated `<script type="text/plain" data-ci-consent>` tags. Options: `nonce`, `requireNonce`, `allowedOrigins`. |

### Development

| Option | Type | Default | |
| --- | --- | --- | --- |
| `debug` | boolean | `false` | Log what the library does to the console (`🔍 [Analytics] …`). Also exposes the console helpers. |
| `exposeGlobals` | boolean | `false` | Add `window.ciAnalytics` console helpers (owner tracking, debug, attribution, banner). |

## Where to set each option

| Option | Script tag | Nuxt `runtimeConfig.public` | Vite environment variable |
| --- | --- | --- | --- |
| `apiBaseUrl` | `data-api-base-url` | `apiBaseUrl` | `VITE_API_BASE_URL` |
| `siteKey` | `data-site-key` | `analyticsSiteKey` | `VITE_ANALYTICS_SITE_KEY` |
| `credentials` | `data-credentials` | `analyticsCredentials` | `VITE_ANALYTICS_CREDENTIALS` |
| `cookieDomain` | `data-cookie-domain` | `analyticsCookieDomain` | `VITE_ANALYTICS_COOKIE_DOMAIN` |
| `websiteBaseUrl` | `data-website-base-url` | `websiteBaseUrl` | `VITE_WEBSITE_BASE_URL` |
| `debug` | `data-debug="true"` | `analyticsDebug` | `VITE_ANALYTICS_DEBUG` |
| `banner` | `data-banner="false"`, or `ciAnalyticsConfig` | `analyticsBanner` (object, JSON or `false`) | `VITE_ANALYTICS_BANNER` (JSON or `false`) |
| `consent` | `ciAnalyticsConfig` | `analyticsConsent` (object or JSON) | `VITE_ANALYTICS_CONSENT` (JSON) |
| `respectGlobalPrivacyControl` | `ciAnalyticsConfig` | `analyticsRespectGpc` | `VITE_ANALYTICS_RESPECT_GPC` |
| `integrations` | `ciAnalyticsConfig` | `analyticsIntegrations` (object or JSON) | `VITE_ANALYTICS_INTEGRATIONS` (JSON) |
| `gatedScripts` | `ciAnalyticsConfig` | `analyticsGatedScripts` (object, JSON or `false`) | `VITE_ANALYTICS_GATED_SCRIPTS` (JSON or `false`) |
| `flushInterval` | `ciAnalyticsConfig` | `analyticsFlushInterval` | `VITE_ANALYTICS_FLUSH_INTERVAL` |
| `batchSize` | `ciAnalyticsConfig` | `analyticsBatchSize` | `VITE_ANALYTICS_BATCH_SIZE` |
| `maxRetries` | `ciAnalyticsConfig` | `analyticsMaxRetries` | `VITE_ANALYTICS_MAX_RETRIES` |
| `autoTrackScrollDepth` | `ciAnalyticsConfig` | `analyticsTrackScrollDepth` | `VITE_ANALYTICS_TRACK_SCROLL_DEPTH` |
| `autoTrackTimeSpent` | `ciAnalyticsConfig` | `analyticsTrackTimeSpent` | `VITE_ANALYTICS_TRACK_TIME_SPENT` |
| `autoTrackOutboundLinks` | `ciAnalyticsConfig` | `analyticsTrackOutboundLinks` | `VITE_ANALYTICS_TRACK_OUTBOUND_LINKS` |
| `cleanAttributionUrl` | `ciAnalyticsConfig` | `analyticsCleanAttributionUrl` | `VITE_ANALYTICS_CLEAN_ATTRIBUTION_URL` |
| `urlQueryAllowlist` | `ciAnalyticsConfig` | `analyticsUrlQueryAllowlist` (array or comma list) | `VITE_ANALYTICS_URL_QUERY_ALLOWLIST` (comma list) |
| `exposeGlobals` | `ciAnalyticsConfig` | `analyticsExposeGlobals` | `VITE_ANALYTICS_EXPOSE_GLOBALS` |
| `initialContext`, `plugins` | `ciAnalyticsConfig` (`plugins` as objects) | not available | `initViteAnalytics(router, { … })` |

Notes:

- With the script tag, `data-*` attributes win over `window.ciAnalyticsConfig`.
- Vite variables are strings: booleans are `true`/`false`; objects are JSON.
- In Nuxt and Vite, an unset site key falls back to the deprecated `eventSiteName` (Nuxt
  default `nuxt-app`, `VITE_EVENT_SITE_NAME`, default `vite-app`). Set the site key
  explicitly.
- `initViteAnalytics(router, overrides)` takes any option as its second argument, over the
  environment variables.

## Example

```ts
initBrowserAnalytics({
  apiBaseUrl: 'https://api.example.com/analytics',
  siteKey: 'my-site',
  credentials: 'include',
  websiteBaseUrl: 'https://www.example.com/',
  banner: { title: 'Cookies on example.com', position: 'bottom' },
  consent: { choices: 'categories' },
  integrations: {
    googleAnalytics: {
      measurementId: 'G-XXXXXXXXXX',
      adsConversions: { sign_up: 'AW-123456789/AbCdEf' },
    },
    metaPixel: { pixelId: '1234567890' },
  },
  urlQueryAllowlist: ['q', 'page'],
  cookieDomain: 'example.com',
})
```

## Older settings

These still work, and map to the integrations with their previous behavior (page-installed
Google and Microsoft tags, all events forwarded). Explicit `integrations` settings win.

| Option | Now |
| --- | --- |
| `eventSiteName` | `siteKey` |
| `gaMeasurementId`, `googleAdsConversions` | `integrations.googleAnalytics` |
| `microsoftAdsTagId`, `microsoftAdsGoals` | `integrations.microsoftUet` |
| `openAIAdsPixelId`, `openAIAdsEvents`, `openAIAdsDebug` | `integrations.openAIAds` |
| `chatAccessKey` and the other `chat*` options | `integrations.clearIdeasChat` |
| `consentCheckInterval`, `sessionCheckInterval` | ignored since v1 |

In Nuxt they keep their names (`gaMeasurementId`, ...); in Vite, `VITE_GA_MEASUREMENT_ID`,
`VITE_GOOGLE_ADS_CONVERSIONS`, `VITE_MICROSOFT_ADS_TAG_ID`, `VITE_MICROSOFT_ADS_GOALS`,
`VITE_OPENAI_ADS_PIXEL_ID`, `VITE_OPENAI_ADS_EVENTS`, `VITE_OPENAI_ADS_DEBUG` and
`VITE_CHAT_*`.
