# Dependency maintenance

The published package has **no runtime dependencies**. The only peer dependency is `nuxt`, which is optional and needed only for the Nuxt plugin (`@clearideas/consent-analytics/nuxt`).

## Peer dependencies

- `nuxt`: `^3.0.0 || ^4.0.0`. The plugin uses only `useRuntimeConfig` (from `nuxt/app`), `nuxtApp.hook('app:mounted' | 'page:start')` and `nuxtApp.provide`, all of which exist in Nuxt 3 and 4. The range is based on that API surface; there is no automated Nuxt integration test yet.
- `vue` and `vue-router` are **not** dependencies. No source file imports them. The Vite adapter accepts an existing router instance (duck-typed `afterEach`) and falls back to `popstate` without one.

## Development toolchain

Lockfile regenerated on 2026-11-10 from versions available on the public registry. Intentional constraints:

- TypeScript stays on 6.0.x (6.0.3). typescript-eslint supports TypeScript `<6.1`; TypeScript 7 is outside that range. Upgrade after the parser adds support and all checks pass.
- `@types/node` follows the Node.js 24 line (24.19.2), matching the release/build runtime.
- Tests run in `happy-dom` (a simulated browser DOM) via Vitest. See `vitest.config.ts` and `test/setup.ts`.
- The `minimatch` override pins the patched `^11.0.5` release because eslint, `@eslint/config-array` and `@typescript-eslint/typescript-estree` still request `^10.x`. Remove the override once their ranges include the fix (`npm explain minimatch` shows the requested ranges).

Do not use `npm audit fix --force`; it can downgrade the toolchain.

## Sample host

`sample-host/` is a separate, private package with its own lockfile. Its runtime dependencies are pinned to exact versions: `hono` and `@hono/node-server` (the app around the collector), and `ajv`, `ajv-formats` and `yaml` (`src/spec.ts`, the spec validator the contract tests use). The collector itself is the server library, imported from `../server/src`; it has no dependencies, so nothing else is installed, and storage is the library's SQLite store on Node's built-in `node:sqlite`.

End-to-end tests use `@playwright/test` (a root dev dependency). CI installs Chromium with `npx playwright install --with-deps chromium`.

## Server library

`server/` (`@clearideas/consent-analytics-server`) is a separate package with its own lockfile. It has **no runtime dependencies and no peer dependencies**; that is a product promise, checked on every build:
- `server/scripts/check-package.mjs` packs the package, rejects any `dependencies`/`peerDependencies`/`optionalDependencies`, and allows only relative and `node:` imports in `dist/`. It then installs the tarball into an empty project offline and asserts exactly one package is installed.
- ESLint allows only `node:` and relative imports in `server/src`, and `server/test/boundaries.test.ts` checks that relative imports stay inside it.

Its devDependencies reuse versions already used in this repository (TypeScript, Vitest, `@types/node`; `ajv`, `ajv-formats` and `yaml` as in `sample-host`). Ajv runs only at build time: `server/scripts/generate.mjs` turns the spec into standalone validator code. The two small runtime helpers that code needs are adapted into `server/src/protocol/runtime.ts` (MIT notices in `server/THIRD_PARTY_NOTICES.md`), and tests prove they match the originals.

Database, queue and cache clients are used only as devDependencies of `server/`, to test the adapters against real services. Applications pass in their own clients. Test-only clients, pinned exactly:

| Client | Version | Tests |
| --- | --- | --- |
| `express` / `express4` (alias of Express 4) | 5.3.0 / 4.22.3 | Express middleware, contract suite |
| `cors` | 2.8.6 | a global `cors()` before the collector |
| `mongodb`, `mongoose` | 7.8.0, 9.12.1 (same driver) | MongoDB store and sites |
| `@redis/client`, `ioredis`, `@upstash/redis` | 6.3.1, 6.0.0, 1.39.0 | Redis adapters (Upstash through a fake of its HTTP client) |
| `pg`, `@types/pg` | 8.23.1 | Postgres store |
| `mysql2` | 3.24.5 | MySQL store |
| `@aws-sdk/client-sqs` | 3.1164.0 | SQS queue |
| `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` | 3.1162.0 | DynamoDB store |

The services themselves (MongoDB 8, Redis 7, Postgres 16, MySQL 8, moto for SQS and DynamoDB) come from the environment (`*_URL` variables; service containers in CI) or are installed locally by `server/scripts/test-services.mjs` into `server/.cache/` (see CONTRIBUTING).

## Standalone collector

`collector/` (`@clearideas/consent-analytics-collector`) is an application package with its own lockfile, and unlike the server library it has runtime dependencies: the drivers it may need, pinned to the same exact versions as the server's test clients (`mongodb`, `@redis/client`, `pg`, `mysql2`, `@aws-sdk/client-sqs`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`). Drivers are loaded only when the configuration uses them. Its dependency on the server package is `file:../server` in the repository; the publish workflow replaces it with the exact server version, which must already be on npm (`collector/scripts/check-package.mjs` with `RELEASE=1` enforces it).

## Documentation site

`docs/` is a separate, private package (`@clearideas/consent-analytics-docs`) with its own lockfile. Its only direct dependency is `vitepress` (1.6.4, exact), a development dependency used to build the static site; nothing from it is published or shipped with the packages. The Inter font is self-hosted in `docs/public/fonts/` (SIL Open Font License, `Inter-LICENSE.txt` next to it), so the site makes no third-party font requests.

## Supply-chain gate

CI and the publish workflow run `scripts/check-npm-release-age.mjs` before `npm ci`, for every lockfile: the library, `sample-host/`, `server/`, `collector/`, `docs/` and the examples. For every package in `package-lock.json` it requires:

1. the package resolves from `https://registry.npmjs.org/` (git URLs, tarball URLs, other registries and missing sources fail), and
2. the locked version was published at least `NPM_RELEASE_AGE_DAYS` days ago (default 3).

Only the first-party `@clearideas` scope is exempt from the age requirement. The script refuses to pass if it checked nothing.

## After changing dependencies

```sh
npm install
NPM_RELEASE_AGE_DAYS=3 node scripts/check-npm-release-age.mjs
npm audit
npm run check
```
