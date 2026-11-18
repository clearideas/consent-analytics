# Contributing

Use Node.js 22.22.3+ or 24.15+ and npm. Clone the repository, then run:

```sh
npm ci
(cd sample-host && npm ci)   # the reference collector (the server library in a small app); tests use it
npm run check
```

The checks lint and type-check source, run the test suite, build the package, and inspect a locally packed release.

`npm test` (here, in `server/` and in `collector/`) first runs `scripts/ensure-deps.mjs`: if a package's installed dependencies are missing or differ from its lockfile (a fresh clone, or after pulling a lockfile change), it runs `npm ci` there (for the root tests: the root and `sample-host/`; for the collector: also building `server/`). Set `SKIP_INSTALL_CHECK=1` to turn this off. Unit and integration tests use local mocks and need no Clear Ideas account, provider key, AWS credentials, or private npm token.

## Tests

Tests run with Vitest in a simulated browser DOM (`happy-dom`). `npm test` runs them; `npm run test:coverage` also enforces the coverage floors in `vitest.config.ts`, which only ever go up. `npm run check` uses the coverage run.

- `test/setup.ts` isolates every test. It removes listeners and intervals the library registers, clears storage, cookies, the DOM, the URL and vendor globals, and fails any unmocked `fetch`.
- `test/helpers.ts` provides `makeConfig()`, `mockApi()` (a fake backend that records `fetch` and `sendBeacon` requests), `makeAdapter()` (a framework adapter with a `navigate()` helper), `seedGeo()`, `seedConsent()` and `settle()`.
- Place unit tests next to the module (`src/foo.test.ts`). Behavior tests that boot the library like an application (`boot()`), adapter tests (Vite, Nuxt) and tests of the harness itself live in `test/`.
- A bug fix starts with a test that fails without the fix. Check that the test really fails (e.g. by temporarily reverting the fix), because a test that cannot fail protects nothing.

### Integrations

Built-in integrations are plugins in `src/plugins/` (see `AnalyticsPlugin` in `src/plugins/types.ts`); `src/plugins/host.ts` runs them. Rules:
- Plugins never check consent themselves; the host decides when they load and which events they receive.
- Vendor code is loaded only in `load()`. A spec with `loadWithoutConsent` (page-installed tags) must not load vendor code at all.
- Declare the vendor's first-party cookies (and storage keys) so they are deleted on refusal and withdrawal.
- Test a plugin with a fake `PluginContext` (see `src/plugins/*.test.ts`, `pluginContext()` in `test/helpers.ts`).

Adding a service to the plugin directory:
1. `src/plugins/<service>.ts`: the factory. Validate account IDs with `vendorId()` before using them in a URL. Set up the vendor's command queue before loading its script. Accept `scriptUrl`. Forward only mapped events; never `attribution`.
2. Set `withdrawal` from what the vendor's API can do: `'stop'` only if `consentChanged()` really stops it, otherwise `'reload'`. If you can't tell, use `'reload'`.
3. Turn off the vendor's own consent banner, if it has one.
4. Cookie and storage names go in `vendor-cookies.ts`, so the core can delete them without loading the plugin.
5. Register it in `loader-types.ts` (`BUILT_IN_PLUGINS`), `loaders.ts` (dynamic `import()`), `registry.ts` (options type and spec), `index.ts` (exports), and `SCRIPT_PLUGINS` in `rollup.config.js`. The registry test checks that the spec matches the plugin, and `npm run check:package` checks the script-tag files and their integrity hashes.
6. Document it in `docs/browser/third-party.md`: category, withdrawal, cookies, and the vendor API calls used, so reviewers can check them against the vendor's documentation.

Consent-gated scripts (`src/gated-scripts.ts`) must never start an inert script that might be injected markup: keep the nonce rules (see `docs/browser/third-party.md`) and their tests (`src/gated-scripts.test.ts`, `e2e/third-party.spec.ts`).

### Consent behavior

Some consent behavior exists because of GDPR and the ePrivacy Directive: reject as prominent as accept, no pre-ticked categories, append-only consent records, asking again on a new policy version, deleting data on withdrawal, and "unknown region means consent required". [Consent and the banner: Why it works this way](docs/browser/consent.md#why-it-works-this-way) lists each one and its reason. A change that weakens one of them needs that reason addressed in the pull request. Don't describe the project as compliant with any regulation or as a certified consent platform; describe what it does.

### Contract and end-to-end tests

- `spec/openapi.yaml` is the contract. `sample-host/test/contract.test.ts` checks the reference collector against it, and `test/v1-protocol.test.ts` and `test/client-host.test.ts` check the client against it. A change to the protocol changes the spec first.
- `npm run test:e2e` builds the library and runs `e2e/*.spec.ts` in Chromium against the playground. Install a browser once with `npx playwright install chromium`. To use an existing Chromium binary instead, set `PW_CHROMIUM_EXECUTABLE=/path/to/chrome`. Where Playwright's browser download is blocked but the npm registry is reachable, `@sparticuz/chromium` ships Chromium inside its npm package. In a scratch directory, run `npm i @sparticuz/chromium` and then `node --input-type=module -e "import c from '@sparticuz/chromium'; console.log(await c.executablePath())"`, which extracts Chromium to `/tmp/chromium`. It may be a few versions older than Playwright's; the suite passes with 153 against Playwright 1.65. Do not add flags such as `--disable-web-security`: they remove the `Origin` header and CORS, which the tests verify.
- `npm run playground` starts the same setup for manual exploration. A change to consent behavior should come with a playground scenario (`sample-host/playground/assets/lib/scenarios.js`): scenarios run in the playground for people and in CI for the build (`e2e/playground-pages.spec.ts` fails if any check fails).

### Collector library (`server/`)

`server/` is a separate package (`@clearideas/consent-analytics-server`) with its own lockfile:

```sh
cd server && npm ci && npm run check
```

- It has no dependencies. Don't add `dependencies` or `peerDependencies`. Adapters take the caller's client (database, queue, cache) through a small interface, and never import it. `npm run check:package` enforces this on the packed tarball.
- `src/protocol/generated/` is generated from `spec/openapi.yaml` by `npm run generate`. After changing the spec, regenerate and commit the result; `check` fails on stale files.
- Browser code (`src/`) and server code (`server/src/`) must not import each other (ESLint + `test/boundaries.test.ts`, `server/test/boundaries.test.ts`).
- New stores pass `test/support/store-conformance.ts`, new queues `test/support/queue-conformance.ts`.
- Design and phases: [docs/design/server-plan.md](docs/design/server-plan.md).

**Real services.** The adapter tests use MongoDB, Redis, Postgres, MySQL and moto (an SQS and DynamoDB emulator). `server/test/support/services.ts` (Vitest global setup, also used by `collector/`) finds them in this order:
1. `TEST_MONGODB_URL`, `TEST_REDIS_URL`, `TEST_POSTGRES_URL`, `TEST_MYSQL_URL`, `TEST_AWS_ENDPOINT_URL` (prefixed on purpose: the tests create and drop databases, so they never use your application's `MONGODB_URL`), e.g. with your own containers:
   ```sh
   docker run -d -p 27017:27017 mongo:8 && docker run -d -p 6379:6379 redis:7
   docker run -d -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
   docker run -d -p 3306:3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes mysql:8.0
   docker run -d -p 5000:5000 motoserver/moto:5.2.5
   ```
2. otherwise, local binaries, started for the test run on free ports: on `PATH`, or installed without root by `node server/scripts/test-services.mjs` (Linux x64: Redis, Postgres and MySQL from Ubuntu packages, moto in a Python virtualenv; into `server/.cache/services`). For MongoDB, extract the MongoDB server tarball next to the repository or set `MONGOD_BIN`.

A service that is missing, unreachable or fails to start is reported in one warning line and its tests are skipped; `npm test` still passes. `REQUIRE_SERVICES=1` (as in CI) turns that into a failure; `SERVICES=none` or e.g. `SERVICES=redis,mongodb` limits what is started.

### Standalone collector (`collector/`)

`collector/` (`@clearideas/consent-analytics-collector`) is the server library as a configurable service (environment variables, CLI, Docker image):

```sh
(cd server && npm ci && npm run build)    # the collector depends on ../server
cd collector && npm ci && npm run check   # types, tests with real services, build, package checks
```

- It imports the server library only through its package entry points, like any user (ESLint enforces it), so it needs a built `server/dist`.
- `test/cli.test.ts` starts the collector as a process for each store and queue. `scripts/smoke.mjs <url>` checks any running collector; CI runs it against the Docker image.

### Documentation (`docs/`)

The documentation is a [VitePress](https://vitepress.dev) site in `docs/`, with its own
`package.json` and lockfile:

```sh
npm ci --prefix docs
npm run docs:dev     # http://127.0.0.1:5173 (or the next free port), reloads as you edit
npm run docs:build   # what CI runs; fails on dead links
```

- A change to behavior, options or the contract updates the page that describes it, in the
  same pull request. Package READMEs are short front doors that link to the site; don't
  grow them into a second copy.
- Write what the code does, and check it: run examples and commands before documenting
  them. [`docs/README.md`](docs/README.md) has the writing guidelines.
- `docs/design/` holds design notes (such as the server plan). They aren't part of the site.

### Releases

Three packages are released from this repository, by release tag: `v1.2.3` (browser library), `server-v1.2.3` and `collector-v1.2.3` (see `.github/workflows/publish.yml`). Release the server before a collector that needs its new version; the collector is published with the exact server version.

Open a pull request against `main` with a description of the change and its validation. Add focused tests when changing behavior. Use fabricated data and placeholder widget keys in examples; keep `.env`, credentials, generated tarballs, and local service data out of commits.

Contributions are made under the repository's [MIT license](LICENSE). Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Dependency versions and compatibility decisions are documented in [DEPENDENCIES.md](DEPENDENCIES.md).
