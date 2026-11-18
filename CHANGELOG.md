# Changelog

## 0.2.0 — November 18, 2026

### Documentation
- **A documentation site** (VitePress) in `docs/`: a quick start, core concepts, the browser library (frameworks, configuration, consent, events, attribution, third-party tools, signed-in visitors, privacy and security, API reference, troubleshooting), the collector (Express, `node:http` and Fetch, sites and location, data policies, rules, identity, delivery, storage with example queries, stored data, Redis, retention, configuration, the standalone collector, production, custom adapters, troubleshooting), the collector API and the playground. Run it with `npm ci --prefix docs && npm run docs:dev`; CI builds it (`docs` job), failing on dead links.
- The package READMEs are now short introductions that link to the documentation.
- Moved: `docs/THIRD_PARTY.md` → `docs/browser/third-party.md`, `docs/BACKEND.md` → `docs/api-contract.md`, `docs/SERVER_PLAN.md` → `docs/design/server-plan.md`.
- Removed the chat widget CDN guide (`docs/CDN_USAGE.md`). The `clearIdeasChat` integration is unchanged and documented with the other third-party tools.
- Corrected: the collector library's README said the browser library honors `Retry-After` on `429`; it doesn't (it retries `408`, `429` and `5xx` at its next flush, up to `maxRetries`, and batches sent with `sendBeacon` when the page is hidden are not retried).

### Signed-in visitors: `credentials` option
- New option `credentials: 'omit' | 'same-origin' | 'include'` (default `'omit'`, unchanged behavior). Also available as `data-credentials` on the script tag, `analyticsCredentials` in Nuxt and `VITE_ANALYTICS_CREDENTIALS` in Vite.
- With `'include'`, requests to a collector on the same site carry your authentication cookie (`HttpOnly` included), so the collector can identify signed-in visitors (spec 1.1 *Credentialed requests*).
- Enable it together with the site's `credentials: true` on the collector. Tested end to end in Chromium (`e2e/identity.spec.ts`) with the collector library in an Express 5 app.

### Collector API 1.1 (`spec/openapi.yaml`)
These changes are additive. Existing clients and collectors remain valid.
- `503` with `Retry-After` is declared for every endpoint. Clients already retry it like any `5xx`.
- Collectors may store asynchronously, for example through a queue. `202`/`201` then mean *accepted for storage*, and `duplicates` may be `0`.
- Collectors should de-duplicate retried consent records (identical `siteKey`, `consentId`, `decidedAt`, `decision`, `categories` and `policyVersion`) and return the same `recordId`.
- **Credentialed requests (optional, per site):** a site may allow cookies, so the collector can identify signed-in visitors from the website's own authentication. Identities may be stored only with `full` events.
- **Tracking categories, clarified:**
  - `limited` also covers an explicit refusal where consent is not required (`consent.required: false`, `granted: false`).
  - Collectors must not store IP addresses or identities with `limited` events.
  - Collectors may store more with `full` events.
- **Event catalog:** a props schema for each standard event (`x-event-catalog`), plus `FullEventContext`. The table of standard events now matches what the library sends: `web_vital` carries the page context, `time_spent` also sends `duration`, and `auto_metrics` is sent twice.
- `x-limited-tracking` lists the event names and fields allowed in `limited` events.
- Tests:
  - `test/spec-catalog.test.ts` produces every standard event with the real library and checks each against the catalog; every field the browser sends must be documented.
  - The browser's `limited` allowlists are tested against `x-limited-tracking`.

### Web vitals, measured correctly
- Observers are registered with `buffered: true`. FCP and TTFB happen before the library usually starts, so they were almost never recorded; now they are.
- FCP is the `first-contentful-paint` entry (the `first-paint` entry was reported as FCP too). TTFB counts from navigation start (it measured only the server's response time).
- LCP is reported once, when the page is first hidden, with its final value and the landing page's context (every candidate was sent before).
- CLS uses session windows (the largest window counts, as web.dev defines it) and is reported again only when it changes.
- **New: INP**, the responsiveness metric that replaced FID (worst interaction, 98th percentile with many interactions), reported when the page is hidden. FID is still sent. The spec's `WebVitalProps.name` gains `INP` (additive, spec 1.1).
- Browsers without the buffered form or an entry type keep working (unbuffered, or skipped).

### Playground
- **Redesigned** in the Clear Ideas style, with four pages: an overview, a **live** playground (the demo website in a browser frame, driven from visitor controls, with every request animated from the browser to the collector and into storage), **scenarios** (15 scripted visitor journeys, each checking the browser, the network, the collector and Google), and **analytics** (charts of everything stored, plus simulated visitors from several regions).
- The demo website moved to `/site/` and is a standalone page; a wiretap records what the library sends. The end-to-end tests run every scenario (`e2e/playground-pages.spec.ts`).
- The sample host takes `DATA_POLICY=strict|balanced` (default `strict`); the playground uses `balanced` to show the server-side enrichment. New `/_dev/info`.

### Collector library and standalone collector (0.1.0)
- New package `server/` (`@clearideas/consent-analytics-server`). It has **no runtime or peer dependencies**. The first part is the protocol module: validators and types generated from the spec, tested to behave exactly like Ajv.
- Collector core with `node:http` and Fetch API transports, an in-memory store, static sites and header geo. The contract tests run through every transport.
- `test/client-host.test.ts` now runs the browser library against both the reference collector and the new server.
- Per-region data policies, server-side enrichment, event rules (repair, not reject), consent annotations, and a typed projection of events following the spec's catalog. `test/spec-catalog.test.ts` checks that the projection uses every value the real browser library sends.
- Delivery modes for the collector library: direct, buffered in process, or through a queue to a worker.
- MongoDB store and site source, retention (TTL indexes and a purge job), and data subject export and erasure.
- Browser and server code can't import each other (ESLint rules + `test/boundaries.test.ts`, `server/test/boundaries.test.ts`).
- Redis (rate limits, shared caches, locks, a Redis Streams queue) for node-redis, ioredis and Upstash; IPinfo geolocation; `trustProxy` with CIDR ranges; rate limits (`429`).
- SQS queue; Postgres, MySQL, DynamoDB and SQLite stores. Every store passes the same conformance suite against a real database.
- New package `collector/` (`@clearideas/consent-analytics-collector`): the library as a standalone service, configured with environment variables, with API/worker modes, health and metrics endpoints, and a Docker image. `docker-compose.yml` now runs it (previously the sample host).
- **The sample host is now built on the server library**: its own storage, validation and geo code is gone, and the contract, client-host and end-to-end tests run against the library. Its `/_dev` endpoints and the playground are unchanged.
- Fixed: a continent header listed as trusted (`cf-ipcontinent`) could be read as a country when the country header was missing or `T1` (Tor), e.g. `NA` as Namibia. This affected the previous sample host too.
- `npm test` in the root, `server/` and `collector/` installs missing or outdated dependencies first (`scripts/ensure-deps.mjs`). Test services are configured with `TEST_*` variables (`TEST_MONGODB_URL`, ...), never an application's own `MONGODB_URL`; a service that is unreachable or fails to start skips its tests with a warning instead of failing the run (unless `REQUIRE_SERVICES=1`).
- CI: jobs for the standalone collector (all stores and queues as service containers) and its Docker image (smoke test, non-root, clean shutdown). Releases are by tag: `v*`, `server-v*`, `collector-v*`.

### Third-party tools
- **Plugin directory:** HubSpot, Intercom, Meta Pixel, LinkedIn Insight Tag, Microsoft Clarity and Hotjar join Google Analytics/Ads, Microsoft UET, OpenAI Ads and Clear Ideas Chat. Each is configured by name under `integrations`, is a separate chunk, and is downloaded only when configured and allowed. Account IDs are validated before they're used in a script URL. See `docs/browser/third-party.md`.
- **Consent-gated scripts** for tools without a plugin: `<script type="text/plain" data-ci-consent="marketing" src="…">` runs once its category is allowed. Scripts start in document order (an inline snippet waits for the library above it), and tags added later are picked up. `data-ci-cookies`/`data-ci-storage` name the data to delete. Options: `gatedScripts` (`nonce`, `requireNonce`, `allowedOrigins`), or `false` to turn it off.
- **Content Security Policy:** under `'strict-dynamic'`, a naive script activator would let injected HTML run code (verified in Chromium). Where the page uses nonces, only gated tags carrying the page's nonce are started; the nonce is read from the library's script tag or `gatedScripts.nonce`.
- **Refusal and withdrawal:** declared vendor cookies and, new, storage keys (`storage` on plugins) are deleted on an explicit refusal too, on every page load while it stands. Before, they were deleted only when withdrawn after the plugin had run. A withdrawal that running code can't apply in place (plugins with `withdrawal: 'reload'`, custom plugins without `consentChanged`, gated scripts that ran) reloads the page once after the decision is saved. `consent: { reloadOnWithdrawal: false }` turns this off.
- **Settings link:** `<a href="#ci-consent-settings">`, `data-ci-consent-settings` or the class `ci-consent-settings` reopens the banner from anywhere (e.g. the footer), in every region. It's handled before client-side routers (tested with all seven example apps), and it also works when arriving at `#ci-consent-settings`. With such a link on the page, the floating "Cookie settings" button isn't added (`manageButton: 'auto'`).
- **Script-tag build:** integrations are separate files (`dist/script-plugins/<name>.<hash>.js`) loaded with Subresource Integrity, using hashes built into `analytics.js`. A tampered file is refused (verified in Chromium). `analytics.js` no longer inlines every integration. `data-plugin-base-url` sets where the files are.
- Custom plugins can declare `storage`, `withdrawal` and `loadWithoutConsent`.
- Nuxt (`analyticsConsent`, `analyticsGatedScripts`) and Vite (`VITE_ANALYTICS_CONSENT`, `VITE_ANALYTICS_GATED_SCRIPTS`) now pass consent options through; `consent: { choices: 'categories' }` was previously not settable there.

### Consent categories
- Optional per-category consent (`consent: { choices: 'categories' }`) for preferences, statistics and marketing. The banner gains a "Customize" view with category checkboxes: none pre-ticked, "Necessary" always on. Simple mode (one accept/reject choice) remains the default and is recorded as the same choice for every category.
- Integrations declare a category. Google Analytics maps Consent Mode v2 per category (`analytics_storage` ← statistics, `ad_*` ← marketing) and fires Ads conversions only with marketing. UET and OpenAI Ads are marketing. Chat is necessary, or preferences with `requiresConsent`. Withdrawing a category deletes that category's vendor cookies only.
- Full first-party analytics and stored attribution follow **statistics**. An explicit refusal is now respected everywhere, including where consent is not required.
- Global Privacy Control now withholds **marketing** only (it is an opt-out of sale/sharing); before, it blocked every third-party integration.
- `analytics.consent.set()`, `consent.get().categories`, `useConsent()` with categories. Plugins: `category` (replaces `requiresConsent`, which still works) and `allowedCategories` in the consent state.
- Collector API: consent records carry `categories`, and `decision` may be `partial`.

### Framework examples
- `examples/`: Next.js 16, React Router 8, Vue 3, Nuxt 4, SvelteKit 3, Angular 22 and Astro 7 apps, built against the packed library and tested in Chromium in CI.
- Fixed, found by the Astro example: frameworks that replace the page body on navigation (view transitions) removed the consent banner. The banner, if unanswered, and the "Cookie settings" button are now restored after navigation.
- The release-age gate skips bundled dependencies (covered by their parent package).

### Tracking without consent, per region
- The collector's policy can say `trackingWithoutConsent: 'none'` for a visitor's region: nothing is sent while statistics consent is not given. The default remains `limited` (anonymous essential events). Site-wide default: `consent: { trackingWithoutConsent }`. The sample collector supports `NO_TRACKING_WITHOUT_CONSENT_COUNTRIES` and a per-site setting.

### More frameworks
- `@clearideas/consent-analytics/browser`: framework-agnostic. `initBrowserAnalytics({ apiBaseUrl, siteKey })` detects page changes from the History API (Next.js, React Router/Remix, SvelteKit, Angular, Astro, …), or from `notifyRouteChange()` with `routeChanges: 'manual'`. It is idempotent (StrictMode, hot reload).
- Script-tag build `dist/analytics.js` (also `unpkg`/`jsdelivr`): configured with `data-*` attributes and/or `window.ciAnalyticsConfig`, with a pre-load command queue (`window.ciAnalyticsQueue`) and the `window.ClearIdeasAnalytics` API. About 18 KB gzipped; integrations are separate, integrity-checked files loaded only when used (see *Third-party tools*).
- `@clearideas/consent-analytics/react`: `AnalyticsProvider`, `useAnalytics()`, `useConsent()` (re-renders on consent changes). SSR- and StrictMode-safe.
- `@clearideas/consent-analytics/next`: `<ClearIdeasAnalytics>` for the App Router (client component; navigations from `usePathname`/`useSearchParams`).
- `analytics.ready()` resolves once the consent policy is known. `consent.accept()`/`reject()` wait for it, so decisions made right after start-up carry the right policy version. Consent listeners are also notified when the policy becomes known.
- URL changes that only remove attribution parameters are no longer treated as a new page.
- CommonJS: `require('@clearideas/consent-analytics/nuxt')` now exposes the plugin as `.default` (named exports were added).

### Integrations as plugins
- Google Analytics / Google Ads, Microsoft UET, OpenAI Ads and Clear Ideas Chat are plugins, enabled with `integrations: { googleAnalytics: {...}, ... }` (Nuxt `analyticsIntegrations`, Vite `VITE_ANALYTICS_INTEGRATIONS`). Each is a separate chunk, downloaded only when configured and allowed. Custom plugins: `plugins: [...]` (see `AnalyticsPlugin`). Factories: `@clearideas/consent-analytics/plugins`.
- The core enforces consent for all plugins. Vendor tags loaded by the library (`loadScript: true`, the default for `integrations`) get their consent state set before configuration. Page-installed tags (`loadScript: false`) are kept in sync (`denied` until allowed). Withdrawing consent deletes vendor cookies (`_ga*`, `_gid`, `_gcl_*`, `_uet*`). The page where a visitor accepts is forwarded once.
- Google Analytics (new config) maps page views to GA `page_view` (`page_location`, ...) with `send_page_view: false`, and skips this library's diagnostic events unless `events: 'all'`. Microsoft UET skips automatic events unless `events: 'all'`.
- Chat supports `integrity`/`cssIntegrity` (Subresource Integrity) and `requiresConsent`.
- The legacy flat settings (`gaMeasurementId`, `microsoftAdsTagId`, `openAIAdsPixelId`, `chat*`, ...) keep working with their previous behavior.
- **Breaking:** `initializeGTag`, `initializeUET`, `initializeOpenAIAdsPixel`, `initializeClearIdeasChat`, `trackIntegratedEvent`, `trackOpenAIAdsEvent`, `updateChatConsent`, `grantAnalyticsConsent` and `revokeAnalyticsConsent` were removed. Use `integrations` and `analytics.consent`. `getChatWidgetInstance` moved to `@clearideas/consent-analytics/plugins`.

### Consent banner and API
- New framework-neutral, accessible banner:
  - built with DOM APIs only (configured text is never parsed as HTML);
  - equal accept/reject buttons;
  - a labelled region that doesn't take focus on page load;
  - configurable text (`banner` option), themeable through `--ci-consent-*` CSS variables;
  - `autoShow`, `position` and `injectStyles` options.
- A "Cookie settings" button (`banner.manageButton`, default `'auto'`) lets visitors change their decision.
- Headless consent API: `analytics.consent.get()`, `accept()`, `reject()`, `onChange()`, `showBanner()`. `banner: false` disables the built-in UI.
- Global Privacy Control is honored by default (`respectGlobalPrivacyControl`): where consent is not required, integrations that need consent do not run for GPC browsers unless the visitor explicitly accepts.
- **Breaking:** the Vuetify-styled banner and `getConsentBannerHTML` were removed. `FrameworkAdapter.showConsentBanner` is no longer used.

### Less fingerprinting data
- No exact screen or viewport sizes, colour depth, pixel ratio, JS heap sizes or network downlink/RTT. Coarse viewport/device buckets remain.
- `limited` (pre-consent) events no longer carry the user-agent string; collectors receive it in the request header.

### Collector API v1 (breaking)
- The client speaks the documented v1 contract in `spec/openapi.yaml`: `GET /v1/context`, `POST /v1/events`, `POST /v1/consent`. The pre-v1 `/event/*` endpoints are no longer used. See `docs/api-contract.md` for the mapping.
- New `siteKey` option (Nuxt `analyticsSiteKey`, Vite `VITE_ANALYTICS_SITE_KEY`). `eventSiteName` still works as a fallback.
- The consent decision is stored in the browser and applies immediately. The collector receives append-only consent records with a stable `consentId` and the `policyVersion`; undelivered records are retried on the next visit. A new policy version asks visitors again.
- Requests carry no cookies (`credentials: 'omit'`) and use `text/plain` JSON bodies, so no CORS preflight is needed and `sendBeacon` works cross-origin.
- Events have an `eventId` (the collector de-duplicates retries), and batches are limited to 50 events / 60 KB. Only network errors, 408, 429 and 5xx are retried.
- Event names are normalized to `^[a-z][a-z0-9_]{0,63}$` and props are fitted to the contract's limits, so the collector does not reject them.
- The `GET /event/session` call and the stored `userId` are gone (removed from storage on startup). The `ci_consent_shown` cookie is no longer set.
- `consentCheckInterval` and `sessionCheckInterval` are deprecated and ignored. New `initialContext` option.
- Added a reference collector and interactive playground (`sample-host/`, `npm run playground`), with contract tests and real-browser end-to-end tests (`npm run test:e2e`).

### Security and privacy
- Page URLs sent to the backend and third parties are reduced to origin + path + campaign parameters; other query parameters and fragments (tokens, emails, session IDs) are removed. New option `urlQueryAllowlist` keeps site-specific parameters. Referrers are reduced to origin + path.
- Google Analytics receives only each event's own parameters. Attribution data, click IDs and library control keys are no longer forwarded as event parameters.
- Attribution accepts only known keys (arbitrary `utm_*`/`ci_*` keys are ignored), drops values over 256 characters, and re-validates data read from storage and cookies.
- **Breaking:** the attribution cookie is opt-in via `cookieDomain` (Nuxt `analyticsCookieDomain`, Vite `VITE_ANALYTICS_COOKIE_DOMAIN`). The domain is validated against the current host and never guessed. Without it no cookie is written and a `ci_click` cookie is ignored. The cookie is now `Secure` on HTTPS.
- **Breaking:** nothing is added to `window` by default, and `window.analytics` is never written. Console helpers (owner opt-out, debug toggles, attribution) are available as a single `window.ciAnalytics` object when `exposeGlobals` or `debug` is enabled. Vite's `useAnalytics()` no longer depends on a global.

### Fixes
- Vite: one `page_view` per route change (was two). A route notification for the URL already being tracked is ignored.
- Attribution is captured when a visitor accepts the consent banner, including after navigating away from the landing page. It was previously lost.
- `page_exit`, `time_spent` and CLS are sent when the page is hidden or unloaded (`visibilitychange`/`pagehide`, via `sendBeacon`); they were previously queued and lost. `page_exit` after a route change now describes the page being left.
- Concurrent sends no longer deliver the same batch more than once.
- Pre-consent `error` events keep their message (truncated to 500 characters).
- `country` and `continent` from the geo response are attached to events.
- `startAutoTracking()` is idempotent; `stopAutoTracking()` removes listeners and observers.
- Cleaning attribution parameters from the URL preserves `history.state` (Vue Router navigation state).
- Vite: `VITE_WEBSITE_BASE_URL` now sets the consent banner's privacy link.

## 0.1.1 — November 12, 2026

Stable publication of the production-validated public browser package. Runtime behavior is unchanged from `0.1.0-rc.1`; release metadata and consumer versions move to stable.

## 0.1.0

Initial public release under the MIT license.

- Browser analytics client for Nuxt and Vite.
- Consent state, attribution, event batching, and optional integrations.
- Documented event/consent backend contract.
- Public contributor checks and npm packaging verification.

## 0.1.0-rc.1 — November 11, 2026

- Prepare the public `@clearideas/consent-analytics` identity and package metadata.
- Add lazy bundled chat loading without a private dependency or mutable CDN alias.
- Honor explicit preference refusal in every consent region.
- Update floating settings-button detection for late SPA footers and attribute changes.
- Export consent CSS for strict-CSP hosts and announce lazy chat readiness.
