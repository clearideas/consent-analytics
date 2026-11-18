---
title: Collector (server)
description: 'The collector library and the standalone collector, their entry points, adapters and requirements.'
---

# Collector

The collector receives what the browser library sends, checks it, adds what your data
policy allows, and stores it in your database. Three ways to run one:

| | Use it when | Start |
| --- | --- | --- |
| **Collector library** (`@clearideas/consent-analytics-server`) | You have a Node.js API (Express, Fastify via `node:http`, Hono, Next.js, ...) and want the collector inside it, with your database, queue and authentication. | [Express](./express.md), [node:http and Fetch platforms](./node-and-fetch.md) |
| **Standalone collector** (`@clearideas/consent-analytics-collector`) | You want a separate service, configured with environment variables: a CLI and a Docker image. | [Standalone collector](./collector.md) |
| **Your own** | You use another language or platform. | [Collector API (v1)](../api-contract.md) |

::: tip Package status
Both collector packages are at 0.1.0 and not yet published on npm. Until they are, install
them from a checkout of the repository (`server/`, `collector/`).
:::

## What the library does

- Implements the [collector API](../api-contract.md): `GET /v1/context`, `POST /v1/events`,
  `POST /v1/consent`, `GET /v1/health`, with CORS, size limits, validation, idempotency,
  problem responses, `503` with `Retry-After` when storage fails, and `429` for rate limits.
- Decides each visitor's consent policy from their region, through a
  [data policy](./data-policy.md), and adds server-side data to events within it: IP address
  (full, truncated or hashed), location, network, parsed user agent, language, Global Privacy
  Control, and the [signed-in visitor](./identity.md).
- Checks each event against the visitor's consent again, and repairs rather than rejects
  ([event rules](./rules.md)).
- Stores events and consent records [directly, through a buffer, or through a queue and a
  worker](./delivery.md), in [MongoDB, Postgres, MySQL, DynamoDB or SQLite](./storage.md).
- Expires records per region ([retention](./retention-and-privacy.md)), and exports or erases
  one person's data on request.

## No dependencies

Installing the library adds exactly one package. It has no dependencies and no peer
dependencies: database, queue and cache adapters work with the clients you already use
(the MongoDB driver or Mongoose, `pg`, `mysql2`, the AWS SDK, node-redis, ioredis) through
small interfaces, and never import them. Validation code is generated from the contract at
build time. A check on every build installs the packed package into an empty project and
verifies this.

## Entry points

| Import | Contents |
| --- | --- |
| `@clearideas/consent-analytics-server` | `createCollector`, sites, geo, data policies, rules, delivery, worker, retention, memory store, protocol validators and types |
| `…/express` | `collectorMiddleware` for Express 5 and 4 |
| `…/node` | `toNodeHandler` (also Connect-style middleware), `createCollectorServer` |
| `…/fetch` | `toFetchHandler` for Fetch API platforms |
| `…/mongodb` | `mongoStore`, `ensureMongoIndexes`, `mongoSites` |
| `…/postgres` | `postgresStore`, `migratePostgres`, `postgresMigrations` |
| `…/mysql` | `mysqlStore`, `migrateMysql`, `mysqlMigrations` |
| `…/dynamodb` | `dynamoStore`, `createDynamoTable` |
| `…/sqlite` | `sqliteStore` (Node.js's built-in `node:sqlite`) |
| `…/redis` | Redis Streams queue, rate limiter, cache and lock, for node-redis, ioredis and Upstash |
| `…/sqs` | `sqsQueue` |
| `…/ipinfo` | `ipinfoGeo`: location from IPinfo |
| `…/schemas/data-policy.schema.json` | JSON Schema of data policy documents, for editor support |

## Requirements

- **Node.js 22.12 or newer** (the SQLite store needs 22.13). The package is ESM; CommonJS can
  `require()` it on Node.js 22.12+.
- **Tested with:** Express 5.3 and 4.22; MongoDB 8.0 (driver 7.8, Mongoose 9); PostgreSQL 16
  (`pg` 8); MySQL 8.0 (`mysql2` 3); Redis 7 (node-redis 6, ioredis 6); SQS and DynamoDB through
  an emulator (AWS SDK v3).
- **Other runtimes:** the Fetch API handler uses only standard APIs plus `node:crypto` and
  `node:net`. Bun and Deno provide those; Cloudflare Workers need the `nodejs_compat` flag.
  These runtimes are expected to work but are not tested.

## A first collector

```ts
import {
  createCollector,
  memoryStore,
  trustedHeaderGeo,
} from '@clearideas/consent-analytics-server'
import { createCollectorServer } from '@clearideas/consent-analytics-server/node'

const collector = createCollector({
  sites: [
    {
      siteKey: 'my-site',
      allowedOrigins: ['https://www.example.com'],
      policyVersion: '1',
    },
  ],
  store: memoryStore(), // use a persistent store in production
  geo: trustedHeaderGeo(['cf-ipcountry']), // only headers your proxy sets
})

const server = createCollectorServer(collector, { port: 8787, trustProxy: 1 })
await server.listen()
process.on('SIGTERM', () => server.close())
```

Next: the [quick start](./quickstart.md) adds a real store, or go straight to
[Express](./express.md).
