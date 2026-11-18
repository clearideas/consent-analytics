---
title: Add it to your site
description: 'Set up the browser library with a script tag, any framework, React, Next.js, Nuxt, Vue, SvelteKit, Angular or Astro.'
---

# Add it to your site

Every integration needs only your collector's address (`apiBaseUrl`) and your site key
(`siteKey`). Everything else is optional: see the [configuration reference](./configuration.md).

| Your site | Use |
| --- | --- |
| Any website, no build tools | [Script tag](#script-tag) |
| React, React Router, Remix, Vite + React | [React](#react) |
| Next.js (App Router) | [Next.js](#next-js) |
| Nuxt 3 or 4 | [Nuxt](#nuxt) |
| Vue 3 + Vite | [Vue with Vite](#vue-with-vite) |
| SvelteKit, Angular, Astro, anything else | [Any framework](#any-framework) |

Working apps for Next.js, React Router, Vue, Nuxt, SvelteKit, Angular and Astro are in
[`examples/`](https://github.com/clearideas/consent-analytics/tree/main/examples). CI builds
each one against the packed library and tests it in a real browser.

## Script tag

Put this in `<head>`:

```html
<script
  async
  src="https://cdn.jsdelivr.net/npm/@clearideas/consent-analytics@X.Y.Z/dist/analytics.js"
  integrity="sha384-…"
  crossorigin="anonymous"
  data-api-base-url="https://collector.example.com/"
  data-site-key="my-site"
></script>
```

- **Pin a version** (replace `X.Y.Z`) in production and add `integrity` (Subresource Integrity) so a change on
  the CDN can't change the code on your site. Third-party plugins are separate files next to
  `analytics.js` (`dist/script-plugins/`), checked against hashes built into `analytics.js`,
  so pinning `analytics.js` pins them too.
- **Self-hosting:** copy `dist/analytics.js` *and* `dist/script-plugins/` to the same folder.
- **Content Security Policy:** put your nonce on this tag; see
  [Privacy and security](./privacy-security.md#content-security-policy).

### Settings

The tag's `data-*` attributes cover the common settings:

| Attribute | Setting |
| --- | --- |
| `data-api-base-url` | `apiBaseUrl` (required) |
| `data-site-key` | `siteKey` (required) |
| `data-cookie-domain` | `cookieDomain` |
| `data-credentials` | `credentials` (`include` or `same-origin`) |
| `data-website-base-url` | `websiteBaseUrl` |
| `data-debug="true"` | `debug` |
| `data-banner="false"` | `banner: false` (your own consent UI) |
| `data-route-changes="manual"` | report navigations yourself with `notifyRouteChange()` |
| `data-auto-init="false"` | don't start; call `ClearIdeasAnalytics.init(config)` yourself |
| `data-plugin-base-url` | where the `script-plugins/` folder is, if not next to `analytics.js` (ends in `/`) |

For everything else (integrations, banner texts, consent options), set
`window.ciAnalyticsConfig` before the tag. `data-*` attributes win over it:

```html
<script>
  window.ciAnalyticsConfig = {
    banner: {
      title: 'Cookies',
      privacyPolicyUrl: 'https://www.example.com/privacy',
    },
    consent: { choices: 'categories' },
    integrations: { googleAnalytics: { measurementId: 'G-XXXXXXXXXX' } },
  }
</script>
<script
  async
  src="…/analytics.js"
  data-api-base-url="…"
  data-site-key="my-site"
></script>
```

### Calling the API

Once loaded, the running instance is `ClearIdeasAnalytics.get()`:

```js
ClearIdeasAnalytics.get().trackEvent('sign_up', { plan: 'pro' })
ClearIdeasAnalytics.get().consent.showBanner()
```

Because the script loads `async`, code that runs earlier can **queue** calls. They run in
order once the visitor's consent policy is known:

```js
;(window.ciAnalyticsQueue = window.ciAnalyticsQueue || []).push([
  'trackEvent',
  'sign_up',
  { plan: 'pro' },
])
window.ciAnalyticsQueue.push(['consent.showBanner'])
```

A command is a method name (`trackEvent`, `trackError`, `flush`, ...) or `consent.` plus a
consent method (`consent.accept`, `consent.showBanner`, ...), followed by its arguments.

Page changes made with `history.pushState` (a single-page app) are detected, as with the
[`/browser` entry point](#any-framework).

## Any framework

`@clearideas/consent-analytics/browser` works in any framework:

```ts
import { initBrowserAnalytics } from '@clearideas/consent-analytics/browser'

const analytics = initBrowserAnalytics({
  apiBaseUrl: 'https://collector.example.com/',
  siteKey: 'my-site',
})
analytics.trackEvent('sign_up', { plan: 'pro' })
```

- Page changes are detected from the History API (`pushState`, `replaceState`, back and
  forward), which the routers of Next.js, React Router, Remix, SvelteKit, Angular, Astro
  (view transitions) and Vue Router use. In-page anchors (`#section`) and the library's own
  URL clean-up don't count as page changes.
- Calling `initBrowserAnalytics` again returns the running instance, so it's safe with hot
  reloading. `getBrowserAnalytics()` returns it too (or `null` before it has started).
- Call it in the browser only. In server-rendered apps, call it from client code (a
  component's mount hook, a client-only plugin).

### Reporting navigations yourself

If you prefer your framework's navigation events, pass `{ routeChanges: 'manual' }` and call
`notifyRouteChange()` after each navigation:

```ts
// SvelteKit: src/routes/+layout.svelte
import { afterNavigate } from '$app/navigation'
import { browser } from '$app/environment'
import { initBrowserAnalytics } from '@clearideas/consent-analytics/browser'

if (browser) {
  const analytics = initBrowserAnalytics(config, { routeChanges: 'manual' })
  afterNavigate(() => analytics.notifyRouteChange())
}
```

```ts
// Angular: main.ts, after bootstrapApplication
import { NavigationEnd, Router } from '@angular/router'
import { filter } from 'rxjs'

const appRef = await bootstrapApplication(AppComponent, appConfig)
const analytics = initBrowserAnalytics(config, { routeChanges: 'manual' })
appRef.injector
  .get(Router)
  .events.pipe(filter(event => event instanceof NavigationEnd))
  .subscribe(() => analytics.notifyRouteChange())
```

```ts
// Astro with view transitions (<ClientRouter />): report each page load.
// The banner is restored automatically when the page body is replaced.
document.addEventListener('astro:page-load', () =>
  analytics.notifyRouteChange(),
)
```

A report for the page that was already tracked is ignored, so reporting the first page
load is harmless.

## React

```tsx
import {
  AnalyticsProvider,
  useAnalytics,
  useConsent,
} from '@clearideas/consent-analytics/react'

export function Root() {
  return (
    <AnalyticsProvider
      config={{
        apiBaseUrl: 'https://collector.example.com/',
        siteKey: 'my-site',
      }}
    >
      <App />
    </AnalyticsProvider>
  )
}

function SignUpButton() {
  const analytics = useAnalytics() // null until mounted in the browser
  return (
    <button onClick={() => analytics?.trackEvent('sign_up')}>Sign up</button>
  )
}

function CookieStatus() {
  // re-renders when the policy is known and after decisions
  const consent = useConsent()
  if (!consent) return null
  return <p>Statistics: {String(consent.categories.statistics)}</p>
}
```

- Safe with server rendering (nothing runs until the provider mounts in the browser) and
  with StrictMode.
- `config` is read once, on mount.
- `routeChanges="manual"` on the provider switches to [manual navigation reports](#reporting-navigations-yourself).
- React Router, Remix and Vite + React need nothing else: their navigations use the History API.

## Next.js

App Router:

```tsx
// app/layout.tsx
import { ClearIdeasAnalytics } from '@clearideas/consent-analytics/next'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <ClearIdeasAnalytics
          config={{
            apiBaseUrl: process.env.NEXT_PUBLIC_COLLECTOR_URL!,
            siteKey: 'my-site',
          }}
        >
          {children}
        </ClearIdeasAnalytics>
      </body>
    </html>
  )
}
```

- Navigations are reported from Next's `usePathname()` and `useSearchParams()`, inside a
  Suspense boundary, so static rendering is unaffected.
- In client components, use `useAnalytics()` and `useConsent()` (exported from
  `@clearideas/consent-analytics/next` too).
- **Pages Router:** use `AnalyticsProvider` from `@clearideas/consent-analytics/react` in
  `pages/_app.tsx`.

## Nuxt

Register the client-only plugin and configure it in the public runtime config:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  plugins: ['@clearideas/consent-analytics/nuxt.client'],
  runtimeConfig: {
    public: {
      apiBaseUrl: 'https://collector.example.com/',
      analyticsSiteKey: 'my-site',
      analyticsBanner: { privacyPolicyUrl: 'https://www.example.com/privacy' },
    },
  },
})
```

Every option has a runtime config key (`analytics…`); object options accept an object or a
JSON string, so you can set them from `NUXT_PUBLIC_*` environment variables. See the
[configuration reference](./configuration.md).

The plugin reports navigations from Nuxt's `page:start` hook and provides the instance as
`$analytics`:

```ts
const { $analytics } = useNuxtApp()
$analytics.trackEvent('sign_up', { plan: 'pro' })
```

To type it, add a declaration file:

```ts
// types/analytics.d.ts
import type { Analytics } from '@clearideas/consent-analytics'

declare module '#app' {
  interface NuxtApp {
    $analytics: Analytics
  }
}
declare module 'vue' {
  interface ComponentCustomProperties {
    $analytics: Analytics
  }
}
export {}
```

::: tip "useRuntimeConfig is not defined"
Not needed with Nuxt 4. On older Nuxt versions, add `@clearideas/consent-analytics` to
`build.transpile` in `nuxt.config.ts`.
:::

## Vue with Vite

```ts
// main.ts
import { createApp } from 'vue'
import { initViteAnalytics } from '@clearideas/consent-analytics/vite'
import App from './App.vue'
import { router } from './router'

initViteAnalytics(router)
createApp(App).use(router).mount('#app')
```

```ts
// In a component
import { useAnalytics } from '@clearideas/consent-analytics/vite'

// throws if initViteAnalytics() has not run
const analytics = useAnalytics()
analytics.trackEvent('button_click', { button: 'hero_cta' })
```

- Configuration comes from `VITE_*` environment variables (`VITE_API_BASE_URL`,
  `VITE_ANALYTICS_SITE_KEY`, ...; see the [configuration reference](./configuration.md)).
  A second argument overrides them: `initViteAnalytics(router, { banner: false })`.
- Navigations are reported from the router's `afterEach`. Without a router, only back and
  forward (`popstate`) are seen; use the [`/browser` entry point](#any-framework) instead.
- Vue and Vue Router are not imported by the library: it uses the router you pass.

## Your own framework adapter

The core entry point takes a configuration and an adapter that tells it about your app:

```ts
import {
  initAnalytics,
  withDefaults,
  type FrameworkAdapter,
} from '@clearideas/consent-analytics'

const config = withDefaults({
  apiBaseUrl: 'https://collector.example.com/',
  siteKey: 'my-site',
})
const adapter: FrameworkAdapter = {
  getConfig: () => config,
  getCurrentPath: () => location.pathname,
  getCurrentUrl: () => location.href,
  getReferrer: () => document.referrer,
  onRouteChange: callback =>
    myRouter.onNavigate(() => callback(location.pathname)),
  onAppReady: callback => callback(),
  onAppDestroy: () => {},
  getRouter: () => myRouter,
}
const analytics = initAnalytics(config, adapter)
```

`onRouteChange` returns an unsubscribe function. Start only one instance per page.
