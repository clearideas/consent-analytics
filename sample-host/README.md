# Sample collector and playground

A reference implementation of the collector contract in [`../spec/openapi.yaml`](../spec/openapi.yaml) ([documented here](../docs/api-contract.md)), plus the **playground**: a demo website running the real library against this collector, scripted visitors that check every layer, and charts of what was collected.

It is intentionally small: the collector is the [server library](../server/README.md) (the same code as in production), mounted in a [Hono](https://hono.dev) app with the library's SQLite store on the built-in `node:sqlite`. By default it uses the strict data policy (it stores what the browser sends, nothing more); the playground runs it with the balanced policy, so you can see the server-side enrichment too. This package adds only the playground and the development endpoints. TypeScript runs directly on Node ≥ 22.18 (type stripping); there is no build step.

For a collector to deploy, use the [standalone collector](../collector/README.md) (environment variables, Docker image), or mount the server library in your own API.

## Playground

From the repository root:

```sh
npm ci && (cd sample-host && npm ci)
npm run playground
```

Open http://localhost:5173 (a tour is in [docs/playground.md](../docs/playground.md)). The collector API runs on http://localhost:8787. Because the two are different origins, the playground is a cross-origin client like a real website.

| Page | What it is |
| --- | --- |
| **Overview** `/` | The collector you're talking to (library, server and spec versions, data policy, storage, region) and the pages below. |
| **Live** `/live` | A visitor's browser: the demo website in a frame. Pick the visitor's region, Global Privacy Control, choices per category, or the collector's "nothing without consent" policy; arrive from an ad or a password-reset link; flush, switch tabs or leave. Every request **animates** from the browser to the collector and into storage, and the inspector shows what was sent (with the collector's answer), what was stored (what the browser sent next to what the collector added), consent records, Google tag calls and browser storage. |
| **Scenarios** `/scenarios` | 15 **scripted visitors**, from "EU visitor, before a decision" to "Collector contract". Each acts on the demo website like a person would, then checks four layers: the **browser** (banner, address bar, storage), the **network** (what left the browser), the **collector** (what it stored), and **Google** (what its tag received). *Run all*, or one at a time, watchable or fast; each check shows its evidence, and *Under the hood* shows the script. |
| **Analytics** `/analytics` | **Charts** of everything stored: events over time (full and limited), consent decisions, choices per category, tracking by country, consent by data-policy profile, event mix, top pages, acquisition, web vitals (p75, rated), scroll depth, time on page, browsers and devices, what the collector added per profile, outbound links, errors, and an event explorer. *Simulate visitors* runs 8 to 32 scripted browsers from several regions and sources, making different choices, through the real library. |
| **Demo website** `/site/` | The site the library runs on: Home, Pricing, Docs and a password-reset page, with actions (`sign_up`, `purchase`, `Newsletter Signup`, `error`), an outbound link, and "Cookie settings" in the footer. It works on its own too. |

Data from all pages goes to the same collector, so the analytics show whatever you, the scenarios and the simulated visitors did. *Reset everything* (Live) or *Clear collected data* (Analytics) start over. The playground pages share the browser's storage with the demo website; use one playground tab at a time.

Everything runs in CI in Chromium: `../e2e/playground-pages.spec.ts` runs every scenario (all checks must pass), drives the live page and simulates visitors for the analytics; `../e2e/playground.spec.ts` tests the demo website directly.

### How it works

- `playground/*.html` and `playground/assets/` are plain HTML, CSS and JavaScript modules, with no build step. The library comes from the repository's `dist/` (`npm run build`).
- The demo website loads `assets/wiretap.js` before the library. It records each request to the collector (fetch and `sendBeacon`, with bodies and answers) and tells the page around it through `postMessage`. Google's tag is a stub that records its calls. A real website needs neither.
- The pages around the site use the collector's development endpoints (`/_dev/*`, `DEV_MODE` only): stored events and consent records, a live stream of changes, the region override, site policy changes, reset, and `/_dev/info`.
- Scenarios are data plus a script (`assets/lib/scenarios.js`), run by `assets/lib/runner.js`. Add one by appending to `SCENARIOS`; the end-to-end test runs it automatically.

More pages on the playground port:
- `/plain/first`: a plain site using only the script tag (`dist/analytics.js`). Tests: `../e2e/script-tag.spec.ts`.
- `/tools/`: third-party tools under a strict Content Security Policy (per-request nonce, `'strict-dynamic'`). It has directory plugins (Meta Pixel, Hotjar) pointed at local stand-ins that record what they receive, consent-gated scripts, an injected comment with inert scripts that must never run, and a footer "Cookie settings" link. `?csp=off` removes the policy; `?lib=tampered` serves altered plugin files, which integrity checks must block. Tests: `../e2e/third-party.spec.ts`.

## Running the collector

```sh
cd sample-host
npm ci
npm start                     # http://localhost:8787, data in ./data/analytics.db
```

For Docker, use the standalone collector instead: `docker compose up` in the repository root runs [`collector/`](../collector/README.md), which reads the same variables as below, and more.

### Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Collector API port |
| `SITES_FILE` | built-in `demo-site` for the playground | JSON array of sites: `siteKey`, `allowedOrigins` (exact origins), `policyVersion`, `consentMode` (`geo`, `always`, `never`). See `sites.example.json`. |
| `DATABASE_PATH` | `./data/analytics.db` | SQLite file, or `:memory:` |
| `TRUSTED_GEO_HEADERS` | *(none)* | Comma-separated request headers carrying the visitor's country, e.g. `cf-ipcountry`, `cloudfront-viewer-country`, `x-vercel-ip-country`. **Only list headers your proxy sets**; otherwise clients can send them and pick their own consent policy. |
| `DEFAULT_COUNTRY` | *(none)* | Country to assume when none is known (local development). Without it, unknown means consent is required. |
| `CONSENT_COUNTRIES` | EU + EEA + UK + CH | Comma-separated ISO codes where consent is required |
| `NO_TRACKING_WITHOUT_CONSENT_COUNTRIES` | *(none)* | Comma-separated ISO codes where browsers may send nothing without consent (`policy.trackingWithoutConsent: none`). Elsewhere, anonymous essential events are allowed. A site can also set `"trackingWithoutConsent": "none"` in the sites file. |
| `CONTEXT_TTL_SECONDS` | `3600` | How long browsers may cache `GET /v1/context` |
| `DATA_POLICY` | `strict` | `strict` stores what the browser sends, nothing more; `balanced` adds server-side enrichment by region (the server library's default). `npm run playground` uses `balanced`. |
| `DEV_MODE` | off | Enables the playground (`PLAYGROUND_PORT`, default `5173`) and the `/_dev/*` endpoints (event listing, live stream, geo override, policy changes, reset, info). **Never enable in production:** `/_dev` is unauthenticated. |

### Adapting it

`src/app.ts` shows how to mount the library in a Hono app: `createCollector({ sites, store, geo, dataPolicy })` and `toFetchHandler(collector)`. Everything the library offers (other stores, IPinfo, queues, identity, rate limits, retention) is in the [collector documentation](../docs/server/index.md); the [standalone collector](../collector/README.md) wires it all up from environment variables.

## Tests

From the repository root: `npm test` runs the contract tests (`test/contract.test.ts`), which check every response against the spec, and the development endpoints. The real browser client also runs against this collector in-process (`../test/client-host.test.ts`). The storage tests are in the server package (`server/test/support/store-conformance.ts`).
