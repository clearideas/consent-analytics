# @clearideas/consent-analytics-server

The collector library for [`@clearideas/consent-analytics`](https://github.com/clearideas/consent-analytics):
it receives what the browser library sends, checks it against the visitor's consent, adds
what your data policy allows, and stores it in your database. It implements the collector
API in [`spec/openapi.yaml`](https://github.com/clearideas/consent-analytics/blob/main/spec/openapi.yaml)
(v1.1), and runs as its own server or inside your existing API.

**[Documentation](https://github.com/clearideas/consent-analytics/blob/main/docs/server/index.md)** ·
[Quick start](https://github.com/clearideas/consent-analytics/blob/main/docs/server/quickstart.md) ·
[Production guide](https://github.com/clearideas/consent-analytics/blob/main/docs/server/production.md)

## What it does

- **The collector API:** `GET /v1/context`, `POST /v1/events`, `POST /v1/consent` and
  `GET /v1/health`, with CORS per site, size limits, validation, idempotency, problem
  responses, rate limits (`429`) and `503` with `Retry-After` when storage fails.
- **Consent by region:** per-region [data policies](https://github.com/clearideas/consent-analytics/blob/main/docs/server/data-policy.md)
  decide whether consent is required and what is added to events: IP address (full,
  truncated or hashed), location, network, parsed user agent, language, Global Privacy
  Control, and how long each is kept.
- **Event rules** that repair rather than reject, consent record annotations, and
  **signed-in visitors** identified from your own authentication.
- **Delivery** per endpoint: written directly, buffered in process, or through a queue
  (Redis Streams, SQS or your own) to a worker.
- **Stores** for MongoDB (driver or Mongoose), Postgres, MySQL, DynamoDB, SQLite and memory,
  all passing the same conformance suite; retention; data subject export and erasure.
- **Redis** for shared rate limits, caches and locks; **IPinfo** for location.

## No dependencies

Installing this package adds exactly one package to your project: no `dependencies` and no
`peerDependencies`. Adapters take the clients you already use (MongoDB, Redis, SQS,
Postgres, ...) through small interfaces and never import them, and validation code is
generated from the spec at build time. `npm run check:package` verifies this on the packed
tarball.

## Requirements

Node.js 22.12 or newer (the SQLite store needs 22.13). The package is ESM; CommonJS can
`require()` it on Node.js 22.12+.

## Quick start

```sh
npm install @clearideas/consent-analytics-server
```

To run the collector with SQLite:

```ts
import { createCollector, trustedHeaderGeo } from '@clearideas/consent-analytics-server'
import { createCollectorServer } from '@clearideas/consent-analytics-server/node'
import { sqliteStore } from '@clearideas/consent-analytics-server/sqlite'

const collector = createCollector({
  sites: [{ siteKey: 'my-site', allowedOrigins: ['https://www.example.com'], policyVersion: '1' }],
  store: sqliteStore({ path: './data/analytics.db' }),
  geo: trustedHeaderGeo(['cf-ipcountry']), // only headers your proxy sets
})

const server = createCollectorServer(collector, { port: 8787, trustProxy: 1 })
await server.listen()
process.on('SIGTERM', () => void server.close())
```

Inside Express 5 or 4:

```ts
import { collectorMiddleware } from '@clearideas/consent-analytics-server/express'

app.set('trust proxy', 1)
app.use('/analytics', collectorMiddleware(collector))
```

In the browser: `apiBaseUrl: 'https://api.example.com/analytics'`, `siteKey: 'my-site'`.

## Entry points

| Import | |
| --- | --- |
| `@clearideas/consent-analytics-server` | `createCollector`, sites, geo, data policies, rules, memory store and queue, delivery, worker, retention, protocol validators and types |
| `/node` | `createCollectorServer` (a `node:http` server) and `toNodeHandler` (Connect-style middleware) |
| `/express` | `collectorMiddleware` for Express 5 and 4 |
| `/fetch` | `toFetchHandler`, for Fetch API platforms (Hono, Next.js route handlers, ...) |
| `/mongodb`, `/postgres`, `/mysql`, `/dynamodb`, `/sqlite` | Stores (and a MongoDB site source) |
| `/redis` | Rate limiter, cache, lock and Redis Streams queue, for node-redis, ioredis and Upstash |
| `/sqs` | SQS queue |
| `/ipinfo` | IPinfo location lookups |
| `/schemas/data-policy.schema.json` | JSON Schema of the data policy document |

Every transport runs the contract tests on Node.js, and Express 5 and 4 are also tested end
to end in a browser. The Fetch handler should work on Bun, Deno and Cloudflare Workers, but
isn't tested there yet: see
[node:http and Fetch platforms](https://github.com/clearideas/consent-analytics/blob/main/docs/server/node-and-fetch.md).

## Documentation

- [How the collector works](https://github.com/clearideas/consent-analytics/blob/main/docs/server/concepts.md)
- [Express](https://github.com/clearideas/consent-analytics/blob/main/docs/server/express.md),
  with a complete MongoDB, Redis, SQS and IPinfo example
- [Sites, origins and location](https://github.com/clearideas/consent-analytics/blob/main/docs/server/sites-and-geo.md)
- [Data policies](https://github.com/clearideas/consent-analytics/blob/main/docs/server/data-policy.md)
  and [event rules](https://github.com/clearideas/consent-analytics/blob/main/docs/server/rules.md)
- [Delivery and queues](https://github.com/clearideas/consent-analytics/blob/main/docs/server/delivery.md),
  [storage](https://github.com/clearideas/consent-analytics/blob/main/docs/server/storage.md),
  [Redis and rate limits](https://github.com/clearideas/consent-analytics/blob/main/docs/server/redis.md)
- [Retention and privacy](https://github.com/clearideas/consent-analytics/blob/main/docs/server/retention-and-privacy.md)
- [Configuration reference](https://github.com/clearideas/consent-analytics/blob/main/docs/server/configuration.md)
  and [custom adapters](https://github.com/clearideas/consent-analytics/blob/main/docs/server/custom-adapters.md)

Don't want to write a server? [`@clearideas/consent-analytics-collector`](https://github.com/clearideas/consent-analytics/tree/main/collector)
runs this library as a service, configured with environment variables, with a Docker image.

## Development

```sh
npm ci
npm run check   # generated code, types, tests with coverage, build, package checks
```

Tests against real databases and queues use `TEST_*` variables (`TEST_MONGODB_URL`, ...);
without them those tests are skipped with a warning. See
[CONTRIBUTING.md](https://github.com/clearideas/consent-analytics/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/clearideas/consent-analytics/blob/main/LICENSE). Third-party
notices: [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
