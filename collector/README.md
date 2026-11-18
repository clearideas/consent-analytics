# @clearideas/consent-analytics-collector

A ready-to-run collector for [`@clearideas/consent-analytics`](https://github.com/clearideas/consent-analytics),
configured with environment variables, with a CLI and a Docker image. It is built on the
collector library,
[`@clearideas/consent-analytics-server`](https://github.com/clearideas/consent-analytics/tree/main/server),
and includes the drivers for every store and queue the library supports.

Use this package for a collector as its own service. To add the collector to an API you
already run (Express, `node:http`, Fetch platforms), use the collector library: it's one
middleware.

**[Documentation](https://github.com/clearideas/consent-analytics/blob/main/docs/server/collector.md)**:
every environment variable, modes, Docker, metrics and logs.

## Quick start

```sh
npm install @clearideas/consent-analytics-collector
SITES_FILE=./sites.json npx consent-analytics-collector
```

- It listens on port 8787 and stores to SQLite in `./data/analytics.db`.
- Sites come from `SITES_FILE`, a JSON array (see the [example site configuration](https://content-analytics.clearideas.com/server/collector#sites)),
  and/or a MongoDB collection (`SITES_MONGODB_COLLECTION`).
- In the browser: `apiBaseUrl: 'http://localhost:8787/'` and your `siteKey`.
- `--check` validates the configuration and exits. An invalid configuration is refused at
  startup, with every problem listed.

## Docker

From the repository root:

```sh
docker build -f collector/Dockerfile -t consent-analytics-collector .
docker run -p 8787:8787 \
  -v "$PWD/collector/sites.example.json:/config/sites.json:ro" \
  -e SITES_FILE=/config/sites.json -e TRUSTED_GEO_HEADERS=cf-ipcountry \
  -v collector-data:/data consent-analytics-collector
```

The image runs as the unprivileged `node` user, stores to SQLite in the `/data` volume by
default, and has a health check on `/healthz`. The repository's `docker-compose.yml` runs
it with SQLite (`docker compose up`), or with MongoDB and Redis and a separate worker
(`docker compose --profile queued up`).

## What it runs

- `MODE=api` (default): the collector API, and the retention job when there is no queue.
- `MODE=worker`: the queue worker and the retention job, for a queued setup where the API
  and the writers scale separately.
- `MODE=all`: both in one process.

Stores: SQLite, MongoDB, Postgres, MySQL, DynamoDB, memory. Queues: Redis Streams, SQS,
memory. Also Redis for shared rate limits and caches, IPinfo or CDN headers for location,
a data policy preset or your own policy file (`DATA_POLICY`), `/healthz`, `/readyz` and Prometheus `/metrics`, and JSON logs.

## As a library

```ts
import { loadConfig, startCollector } from '@clearideas/consent-analytics-collector'

const running = await startCollector(loadConfig({ ...process.env, PORT: '0' }))
console.log(running.url)
await running.stop()
```

## Development

```sh
(cd ../server && npm ci && npm run build)   # the collector uses the local server package
npm ci
npm run check   # types, tests, build and package checks
```

The tests start the collector as a process against SQLite, MongoDB with Redis, Postgres
with SQS (API and worker as two processes), MySQL and DynamoDB, when those test services
are configured; see
[CONTRIBUTING.md](https://github.com/clearideas/consent-analytics/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/clearideas/consent-analytics/blob/main/LICENSE)
