---
title: Collector quick start
description: 'A collector with the library in a few lines: a standalone server with SQLite, then the same collector in Express.'
---

# Collector quick start

## Install

From a checkout of the repository (until the package is published):

```sh
git clone https://github.com/clearideas/consent-analytics.git
(cd consent-analytics/server && npm ci && npm run build)
# in your project:
npm install ../consent-analytics/server
```

Once published: `npm install @clearideas/consent-analytics-server`.

## A standalone server with SQLite

```ts
// collector.ts
import {
  createCollector,
  trustedHeaderGeo,
} from '@clearideas/consent-analytics-server'
import { createCollectorServer } from '@clearideas/consent-analytics-server/node'
import { sqliteStore } from '@clearideas/consent-analytics-server/sqlite'

const collector = createCollector({
  sites: [
    {
      siteKey: 'my-site',
      allowedOrigins: ['https://www.example.com', 'http://localhost:8080'],
      policyVersion: '2026-11-01',
    },
  ],
  store: sqliteStore({ path: './data/analytics.db' }),
  // Behind Cloudflare: its country header. Only list headers your proxy sets.
  geo: trustedHeaderGeo(['cf-ipcountry'], {
    continentHeaders: ['cf-ipcontinent'],
  }),
})

const server = createCollectorServer(collector, { port: 8787, trustProxy: 1 })
const { url } = await server.listen()
console.log(`Collector listening on ${url}`)

// finishes in-flight requests, closes the store
process.on('SIGTERM', () => void server.close())
```

```sh
# Node.js 22.18+ runs TypeScript directly; or compile it first.
# The package is ESM: set "type": "module" in your package.json.
node collector.ts
curl http://localhost:8787/v1/health
```

What this gives you:

- the four endpoints, with CORS for the sites' origins only;
- the `balanced` [data policy](./data-policy.md): consent required in the EEA, the UK,
  Switzerland and wherever the region is unknown; enrichment and retention by region;
- `standard` [event rules](./rules.md);
- request timeouts and graceful shutdown.

Point the browser library at it: `apiBaseUrl: 'http://localhost:8787/'`,
`siteKey: 'my-site'`. Without a trusted country header (for example on your machine), the
region is unknown, so the banner shows; for local testing,
`geo: fixedGeo({ country: 'DE' })` sets one.

## The same collector in Express

```ts
import express from 'express'
import { collectorMiddleware } from '@clearideas/consent-analytics-server/express'

const app = express()
app.set('trust proxy', 1)
app.use('/analytics', collectorMiddleware(collector))
// ... your routes
app.listen(3000)
```

In the browser: `apiBaseUrl: 'https://api.example.com/analytics'`. See [Express](./express.md)
for body parsers, `cors()`, authentication and shutdown.

## Next

- A production database: [Stores](./storage.md) (MongoDB, Postgres, MySQL, DynamoDB).
- Visitor location without a CDN header: [IPinfo](./sites-and-geo.md#ipinfo).
- Sites from your database: [site sources](./sites-and-geo.md#site-sources).
- Fast intake with a queue: [Delivery and queues](./delivery.md).
- Before going live: the [production guide](./production.md).
