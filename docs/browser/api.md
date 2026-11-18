---
title: Browser API
description: 'The analytics instance, the consent API, the functions of each entry point, script-tag globals and the plugin interface.'
---

# Browser API

## The analytics instance

Every integration gives you the same instance (`initBrowserAnalytics()`,
`useAnalytics()`, `$analytics`, `ClearIdeasAnalytics.get()`, `initAnalytics()`).

```ts
interface Analytics {
  trackEvent(name: string, props?: Record<string, any>): void
  trackError(message: string, props?: Record<string, any>): void
  flush(): void
  ready(): Promise<void>
  consent: ConsentApi
  showConsentBanner(): void
  getConsentStatus(): Promise<boolean | null>
  startAutoTracking(): void
  stopAutoTracking(): void
  trackUETEvent(
    action: string,
    label?: string,
    value?: number,
    custom?: Record<string, any>,
  ): void
  trackUETConversion(goalId?: string, revenue?: number, currency?: string): void
}
```

| Member | |
| --- | --- |
| `trackEvent(name, props?)` | Track an event. The name is normalized to `snake_case`; props are fitted to the contract's limits. Sent as full or limited according to consent, or not at all. See [Events and delivery](./events.md). |
| `trackError(message, props?)` | Track an `error` event (essential: sent at once, also as a limited event with the message shortened to 500 characters). |
| `flush()` | Send queued events now. |
| `ready()` | Resolves once the visitor's consent policy is known (the context was fetched, or failed). Events tracked earlier are treated as "consent required". |
| `consent` | The [consent API](#consent-api). |
| `showConsentBanner()` | Show the built-in banner (without moving focus). Prefer `consent.showBanner()`. |
| `getConsentStatus()` | `true` if everything was accepted, `false` for another decision, `null` if undecided. |
| `startAutoTracking()` / `stopAutoTracking()` | Start or remove the automatic tracking (page views, exits, scroll, outbound links, web vitals). Started for you; idempotent. |
| `trackUETEvent()`, `trackUETConversion()` | Direct Microsoft UET calls, for existing code. Prefer the [`microsoftUet` integration](./third-party.md#microsoft-advertising-uet). |

Instances from `/browser`, `/react` and `/next` also have `notifyRouteChange()`: report a
navigation when using `routeChanges: 'manual'`.

## Consent API

```ts
interface ConsentApi {
  get(): ConsentSnapshot
  accept(): Promise<void>
  reject(): Promise<void>
  set(
    choices: Partial<{
      preferences: boolean
      statistics: boolean
      marketing: boolean
    }>,
  ): Promise<void>
  onChange(listener: (state: ConsentSnapshot) => void): () => void
  showBanner(): void
}

interface ConsentSnapshot {
  // consent is required for this visitor
  required: boolean
  // true: all accepted; false: another decision; null: undecided
  granted: boolean | null
  categories: {
    preferences: boolean | null
    statistics: boolean | null
    marketing: boolean | null
  }
  // the browser sends Global Privacy Control (and it's honored)
  gpc: boolean
  // the collector's current policy version
  policyVersion?: string
}
```

| Member | |
| --- | --- |
| `get()` | The current state. Before `ready()` resolves, `required` is `true`. |
| `accept()` / `reject()` | Record *accept all* or *reject non-essential* (`source: "api"`). Waits for `ready()`. |
| `set(choices)` | Record a choice per category; categories not given are not allowed. |
| `onChange(listener)` | Called when the policy becomes known and after each decision. Returns an unsubscribe function. |
| `showBanner()` | Open the built-in banner with focus on the choices (no-op with `banner: false`). |

## Entry points

### `@clearideas/consent-analytics/browser`

| Export | |
| --- | --- |
| `initBrowserAnalytics(options, { routeChanges? })` | Start (once per page) and return the instance. `options` needs `apiBaseUrl` and `siteKey`; `routeChanges`: `'history'` (default) or `'manual'`. |
| `getBrowserAnalytics()` | The running instance, or `null`. |
| `createBrowserAdapter(config, options)` | The framework adapter it uses, for custom setups. |
| `watchHistory(listener)` | Call `listener(path)` on History API page changes. Returns an unsubscribe function. |

### `@clearideas/consent-analytics/react`

| Export | |
| --- | --- |
| `<AnalyticsProvider config routeChanges?>` | Starts analytics when it mounts in the browser. `config` is read once. |
| `useAnalytics()` | The instance, or `null` before it has started (e.g. during server rendering). |
| `useConsent()` | The `ConsentSnapshot`, or `null` before start; re-renders on changes. |

### `@clearideas/consent-analytics/next`

| Export | |
| --- | --- |
| `<ClearIdeasAnalytics config>` | For `app/layout.tsx`; reports navigations from `usePathname()` and `useSearchParams()`. |
| `useAnalytics()`, `useConsent()` | As in `/react`. |

### `@clearideas/consent-analytics/vite`

| Export | |
| --- | --- |
| `initViteAnalytics(router?, overrides?)` | Start with configuration from `VITE_*` variables (plus `overrides`); navigations from `router.afterEach`. |
| `useAnalytics()` | The instance; throws if `initViteAnalytics()` hasn't run. |
| `createViteAdapter(router?)` | The adapter it uses. |

### `@clearideas/consent-analytics/nuxt.client`

A Nuxt plugin (default export). Configuration from `runtimeConfig.public`; provides
`$analytics`. `@clearideas/consent-analytics/nuxt` also exports `nuxtAnalyticsConfig(publicConfig)`,
the mapping from runtime config to options.

### `@clearideas/consent-analytics/plugins`

The built-in plugin factories (`googleAnalytics`, `microsoftUet`, `openAIAds`, `hubspot`,
`intercom`, `metaPixel`, `linkedInInsight`, `microsoftClarity`, `hotjar`, `clearIdeasChat`),
for use with `plugins: [...]` instead of `integrations`, and the plugin types below. Also
the cookie lists of each vendor (`GOOGLE_COOKIES`, `META_PIXEL_COOKIES`, ...).

### `@clearideas/consent-analytics`

| Export | |
| --- | --- |
| `initAnalytics(config, adapter)` | Start with your own [framework adapter](./frameworks.md#your-own-framework-adapter). |
| `createAnalytics(config, adapter)` | Create an instance without starting it (tests). |
| `withDefaults(options)` | Complete options with the defaults (`flushInterval`, `batchSize`, ...). |
| `getAttributionContext(config?)` | The stored first-touch attribution, or `null`. |
| `setDontTrackOwner(on)`, `isDontTrackOwnerEnabled()`, `getDontTrackOwnerStatus()` | [Owner tracking](./events.md#owner-tracking). |
| `enableConsoleDebug()`, `disableConsoleDebug()`, `getConsoleDebugStatus()` | Turn debug logging on or off for this session. |
| `CONSENT_SETTINGS_SELECTOR` | The selector of consent settings links. |
| `STORAGE_KEYS` | The storage keys the library uses. |
| Types | `Analytics`, `AnalyticsConfig`, `ConsentApi`, `ConsentSnapshot`, `BannerOptions`, `IntegrationsConfig`, `FrameworkAdapter`, `AnalyticsPlugin`, ... |

The core also exports internal helpers (URL sanitizing, queue functions, ...). They are
used by the integrations and tests, and may change in minor versions; rely on the ones
listed here.

### `@clearideas/consent-analytics/consent.css`

The banner's stylesheet, for `banner: { injectStyles: false }`.

## Script-tag globals

| Global | |
| --- | --- |
| `ClearIdeasAnalytics.get()` | The running instance, or `null`. |
| `ClearIdeasAnalytics.init(options, { routeChanges? })` | Start manually (with `data-auto-init="false"`). |
| `window.ciAnalyticsConfig` | Options read at start (set it before the script tag). |
| `window.ciAnalyticsQueue` | Commands queued before load: `['trackEvent', name, props]`, `['consent.accept']`, ... Run in order once the policy is known. |

## Console helpers

With `exposeGlobals: true` or `debug: true`, `window.ciAnalytics` offers:

| Helper | |
| --- | --- |
| `instance` | The analytics instance |
| `showCookieBanner()` | Open the banner |
| `getAttributionContext()` | The stored attribution |
| `disableOwnerTracking()`, `enableOwnerTracking()`, `ownerTrackingStatus()` | Exclude your own visits |
| `enableDebug()`, `disableDebug()`, `debugStatus()` | Debug logging for this session |

## Plugin interface

```ts
interface AnalyticsPlugin {
  name: string
  // default 'marketing'
  category?: 'necessary' | 'preferences' | 'statistics' | 'marketing'
  // deleted on refusal and withdrawal
  cookies?: NameRule[]
  // localStorage/sessionStorage keys, deleted the same way
  storage?: NameRule[]
  // default 'stop' with consentChanged, else 'reload'
  withdrawal?: 'stop' | 'reload'
  // bridges to a tag the page installs itself
  loadWithoutConsent?: boolean
  load?(ctx: PluginContext): void | Promise<void>
  consentChanged?(state: PluginConsentState, ctx: PluginContext): void
  track?(event: PluginEvent, ctx: PluginContext): void
}

interface PluginContext {
  readonly config: AnalyticsConfig
  // ConsentState plus `allowed` and `allowedCategories`
  consent(): PluginConsentState
  debug(message: string, data?: unknown): void
  loadScript(src: string, options?: { integrity?: string }): Promise<void>
  loadStylesheet(href: string, options?: { integrity?: string }): Promise<void>
}

interface PluginEvent {
  // as tracked (not normalized)
  name: string
  // safe to forward: own props, URLs sanitized
  params: Record<string, any>
  // all own props, including control keys
  props: Record<string, any>
  // for conversion decisions; never forward as-is
  attribution?: AttributionData
}
```

A `NameRule` is a name (with `*` wildcards), a regular expression, or
`{ name, category }` for a cookie that belongs to another category than the plugin (for
example Google's `_gcl_*` advertising cookies, removed with marketing). See
[Writing a custom plugin](./third-party.md#writing-a-custom-plugin).
