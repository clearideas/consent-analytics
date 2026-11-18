# Consent Analytics

Privacy-first web analytics with a consent banner built in. `@clearideas/consent-analytics`
runs on your website: it asks your collector whether the visitor must consent, shows an
accessible banner where they must, and sends page views, engagement, web vitals and your
own events, within what the visitor allowed. MIT licensed, no runtime dependencies.

- **Any website or framework:** a script tag, or npm with React, Next.js, Vue, Nuxt,
  SvelteKit, Angular, Astro and others.
- **Consent by region:** the collector decides per visitor whether consent is required.
  Until statistics is allowed, only anonymous `limited` events are sent. Choices can be
  per category (preferences, statistics, marketing); Global Privacy Control is honored.
- **Third-party tools under consent:** Google Analytics and Ads, Microsoft UET, Meta Pixel,
  HubSpot, Intercom and others load only when their category is allowed, and are stopped,
  with their cookies removed, on withdrawal. Any other script can be gated too.
- **Attribution:** first-touch campaign parameters and ad click IDs, once allowed, and
  conversions for Google Ads, Microsoft Ads and OpenAI Ads.
- **Your data, your collector:** events and consent records go to a collector you run,
  through a documented HTTP contract ([`spec/openapi.yaml`](https://github.com/clearideas/consent-analytics/blob/main/spec/openapi.yaml)).

**[Documentation](https://content-analytics.clearideas.com/)** ·
[Quick start](https://content-analytics.clearideas.com/getting-started) ·
[Changelog](https://github.com/clearideas/consent-analytics/blob/main/CHANGELOG.md)

## Install

```sh
npm install @clearideas/consent-analytics
```

Or without a build step, from a CDN (pin the version and add `integrity` in production):

```html
<script
  async
  src="https://cdn.jsdelivr.net/npm/@clearideas/consent-analytics@X.Y.Z/dist/analytics.js"
  data-api-base-url="https://collector.example.com/"
  data-site-key="my-site"
></script>
```

## Use

Two settings are required: your collector's address and your site key.

```ts
import { initBrowserAnalytics } from '@clearideas/consent-analytics/browser'

const analytics = initBrowserAnalytics({
  apiBaseUrl: 'https://collector.example.com/',
  siteKey: 'my-site',
})

analytics.trackEvent('sign_up', { plan: 'pro' })
```

React:

```tsx
import { AnalyticsProvider } from '@clearideas/consent-analytics/react'

<AnalyticsProvider config={{ apiBaseUrl: 'https://collector.example.com/', siteKey: 'my-site' }}>
  <App />
</AnalyticsProvider>
```

Next.js, Nuxt, Vue and the others:
[Add it to your site](https://content-analytics.clearideas.com/browser/frameworks).

| Entry point | For |
| --- | --- |
| `dist/analytics.js` | Script tag, any website (`window.ClearIdeasAnalytics`) |
| `@clearideas/consent-analytics/browser` | Any framework; page changes from the History API |
| `@clearideas/consent-analytics/react` | React: `AnalyticsProvider`, `useAnalytics()`, `useConsent()` |
| `@clearideas/consent-analytics/next` | Next.js App Router: `<ClearIdeasAnalytics>` |
| `@clearideas/consent-analytics/nuxt` | Nuxt 3 and 4 plugin |
| `@clearideas/consent-analytics/vite` | Vue with Vite: `initViteAnalytics(router)` |
| `@clearideas/consent-analytics` | Core: `initAnalytics(config, adapter)` for your own adapter |
| `@clearideas/consent-analytics/plugins` | Third-party plugins and the plugin interface |
| `@clearideas/consent-analytics/consent.css` | The banner's stylesheet, for a strict CSP |

`react`, `next` and `nuxt` are optional peer dependencies, needed only for their entry
points.

## A collector

The library needs a collector that implements the
[collector API](https://content-analytics.clearideas.com/api-contract).
Two collector packages are available:

- [`@clearideas/consent-analytics-server`](https://www.npmjs.com/package/@clearideas/consent-analytics-server), the
  collector library, to mount in your own API (Express, `node:http`, Fetch platforms), with
  stores for MongoDB, Postgres, MySQL, DynamoDB and SQLite, Redis, SQS and IPinfo.
- [`@clearideas/consent-analytics-collector`](https://www.npmjs.com/package/@clearideas/consent-analytics-collector), the
  same as a standalone service, configured with environment variables, with a Docker image.

Or write your own in any language, following the contract.

## Documentation

| | |
| --- | --- |
| [Core concepts](https://content-analytics.clearideas.com/concepts) | Consent policy, decisions and records, full and limited events |
| [Consent and the banner](https://content-analytics.clearideas.com/browser/consent) | Texts, styling, categories, your own consent UI |
| [Configuration](https://content-analytics.clearideas.com/browser/configuration) | Every option, with its script-tag, Nuxt and Vite names |
| [Events and delivery](https://content-analytics.clearideas.com/browser/events) | Automatic events, your own events, web vitals, batching |
| [Third-party tools](https://content-analytics.clearideas.com/browser/third-party) | The plugin directory, gated scripts, custom plugins |
| [Privacy and security](https://content-analytics.clearideas.com/browser/privacy-security) | What is stored in the browser, what leaves the page, CSP |
| [API reference](https://content-analytics.clearideas.com/browser/api) | The analytics instance, the consent API, plugin interface |
| [Collector](https://content-analytics.clearideas.com/server/) | The collector library and the standalone collector |

The documentation is a VitePress site in [`docs/`](https://github.com/clearideas/consent-analytics/tree/main/docs):
`npm ci --prefix docs && npm run docs:dev`.

## Playground

A demo website with the library, scripted visitor journeys that check the browser, the
network, the collector and Google, and charts of what was collected:

```sh
npm ci && (cd sample-host && npm ci) && npm run playground
```

Then open http://localhost:5173. See
[Playground](https://content-analytics.clearideas.com/playground).

## Contributing and security

See [CONTRIBUTING.md](https://github.com/clearideas/consent-analytics/blob/main/CONTRIBUTING.md)
for the checks to run, and [SECURITY.md](https://github.com/clearideas/consent-analytics/blob/main/SECURITY.md)
to report a vulnerability privately. Issues:
[GitHub](https://github.com/clearideas/consent-analytics/issues).

## License

[MIT](https://github.com/clearideas/consent-analytics/blob/main/LICENSE)
