---
title: Standalone collector
description: 'Run the collector as its own service, configured with environment variables, from the CLI or the Docker image; API and worker modes, health checks and metrics.'
---

# Standalone collector

`@clearideas/consent-analytics-collector` is the collector library as a ready-to-run
service. It is configured with environment variables, includes the drivers for every store
and queue, and runs from the command line or as a Docker image.

Use it when you want the collector as its own service. To add the collector to an API you
already run, use the [library](./express.md) instead: it's one middleware.

## Run it

From a checkout of the repository (until the package is published):

```sh
(cd server && npm ci && npm run build)
cd collector && npm ci && npm run build
SITES_FILE=./sites.example.json node dist/cli.js
```

Once published: `npx @clearideas/consent-analytics-collector`.

It listens on port 8787 and stores to SQLite in `./data/analytics.db`. `--check` validates
the configuration and exits. With an invalid configuration the collector refuses to start and
lists **every** problem:

```text
Invalid configuration:
  - STORE=postgres needs POSTGRES_URL (or DATABASE_URL)
  - QUEUE=redis needs REDIS_URL
  - RATE_LIMIT_PER_IP must look like 600/1m (requests per window; got "lots")
```

## Docker

Build the image from the repository root, then run it with your sites file mounted:

```sh
docker build -f collector/Dockerfile -t consent-analytics-collector .
docker run -p 8787:8787 \
  -v "$PWD/sites.json:/config/sites.json:ro" -v collector-data:/data \
  -e SITES_FILE=/config/sites.json -e TRUSTED_GEO_HEADERS=cf-ipcountry \
  consent-analytics-collector
```

- The image runs as the unprivileged `node` user, stores SQLite data in the `/data` volume by
  default, and has a health check on `/healthz`.
- [`docker-compose.yml`](https://github.com/clearideas/consent-analytics/blob/main/docker-compose.yml)
  in the repository has two setups: `docker compose up` (SQLite, one process) and
  `docker compose --profile queued up` (MongoDB and Redis, with the API and the worker as
  separate services).

## Sites

Sites come from a JSON file (`SITES_FILE`), a MongoDB collection
(`SITES_MONGODB_COLLECTION`), or both. The file is an array of
[site definitions](./sites-and-geo.md#sites):

```json
[
  {
    "siteKey": "example-site",
    "name": "Example website",
    "allowedOrigins": ["https://www.example.com", "https://example.com"],
    "policyVersion": "2026-11-01",
    "consentMode": "geo",
    "trackingWithoutConsent": "limited"
  }
]
```

Site lookups are cached for `SITES_CACHE_TTL` (60 seconds), and shared between instances
through Redis when `REDIS_URL` is set.

## Modes

| `MODE` | Runs | Use |
| --- | --- | --- |
| `api` (default) | The HTTP collector, and the retention job unless a worker does it | One process with `QUEUE=none`, or the API side of a queued setup |
| `worker` | The queue worker and the retention job; HTTP only for `/healthz`, `/readyz` and `/metrics` | The writing side of a queued setup, scaled separately |
| `all` | Both in one process | A queue for decoupling (`QUEUE=memory`) without a second service |

Every mode serves:

- `/healthz`: liveness, `200` while the process runs;
- `/readyz`: `200` when the store and Redis answer, otherwise `503` with the error;
- `/metrics`: Prometheus text (below), unless `METRICS=false`.

These are on the collector's port: block `/metrics` (and `/readyz` if you like) at your proxy,
or set `METRICS=false`.

On `SIGTERM` or `SIGINT`, the collector stops the worker and the retention job, finishes
in-flight requests, writes what is buffered (up to `SHUTDOWN_TIMEOUT_MS`), then closes its
connections. A second signal exits at once.

## Configuration

### Server

| Variable | Default | |
| --- | --- | --- |
| `MODE` | `api` | `api`, `worker` or `all` |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. JSON lines on stderr. |
| `TRUST_PROXY` | `false` | `true`, a number of proxies (`1` behind one load balancer), or addresses and CIDR ranges (`10.0.0.0/8,fd00::/8`). See [Client IP](./node-and-fetch.md#client-ip). |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | |
| `METRICS` | `true` | Serve `/metrics` |

### Sites

| Variable | Default | |
| --- | --- | --- |
| `SITES_FILE` | | A JSON array of sites |
| `SITES_MONGODB_COLLECTION` | | Sites from a MongoDB collection you manage (needs `MONGODB_URL`) |
| `SITES_CACHE_TTL` | `60s` | How long site lookups are cached |

At least one of `SITES_FILE` and `SITES_MONGODB_COLLECTION` is required.

### Storage

| Variable | Default | |
| --- | --- | --- |
| `STORE` | `sqlite` | `sqlite`, `mongodb`, `postgres`, `mysql`, `dynamodb` or `memory` |
| `DATABASE_PATH` | `./data/analytics.db` | SQLite file (one process only) |
| `MONGODB_URL`, `MONGODB_DATABASE` | | The database from the URL, unless `MONGODB_DATABASE` is set |
| `POSTGRES_URL` (or `DATABASE_URL`) | | |
| `MYSQL_URL` | | MySQL 8 |
| `DYNAMODB_TABLE` | | With the usual AWS configuration (`AWS_REGION`, credentials from the environment or an IAM role) |
| `AWS_REGION`, `AWS_ENDPOINT_URL` | | The endpoint for local emulators |
| `AUTO_MIGRATE` | `true` | Create tables, indexes or the DynamoDB table at startup (idempotent). `false` if your migrations do it. |

### Delivery and queues

| Variable | Default | |
| --- | --- | --- |
| `QUEUE` | `none` | `none`, `redis` (Redis Streams), `sqs`, or `memory` (only with `MODE=all`) |
| `REDIS_URL` | | Also enables shared rate limits, shared site and location caches, and the retention lock |
| `REDIS_STREAM` | `{consent-analytics}:ingest` | |
| `SQS_QUEUE_URL`, `SQS_DEAD_LETTER_QUEUE_URL` | | Without a dead-letter URL, configure a redrive policy on the queue |
| `DELIVERY_EVENTS`, `DELIVERY_CONSENT` | `direct`; `queued` with a queue | `direct`, `buffered`, `queued` (answer once the queue has it), `queued-fast` (answer at once, send in batches). See [Delivery](./delivery.md). |
| `WORKER_CONCURRENCY` | `1` | Receive loops per worker |

`buffered` and `queued-fast` lose what is in memory if the process crashes. Consent records
are evidence: keep `DELIVERY_CONSENT` at `direct` or `queued`.

### Privacy and location

| Variable | Default | |
| --- | --- | --- |
| `DATA_POLICY` | `balanced` | `balanced`, `strict`, or the path of a [data policy](./data-policy.md) JSON file |
| `CONSENT_COUNTRIES` | EEA, UK, Switzerland | Where consent is required (comma-separated codes), for the presets |
| `NO_TRACKING_WITHOUT_CONSENT_COUNTRIES` | | Where nothing is collected without consent |
| `US_PRIVACY_STATES` | the preset's list | States of the balanced preset's `us-privacy` profile, e.g. `US-CA,US-CO` |
| `RULES_PRESET` | `standard` | `standard` (repair), `strict` (reject inconsistent events) or `off` |
| `HASH_SECRET` | | 16 or more characters. Keys for rate limits and caches; required by policies that store hashed IPs. The same on every instance. |
| `TRUSTED_GEO_HEADERS` | | Country (and continent) headers your CDN sets, e.g. `cf-ipcountry,cf-ipcontinent`. Never headers clients could send. |
| `IPINFO_TOKEN` | | Look up the visitor's location with IPinfo (after trusted headers) |
| `DEFAULT_COUNTRY` | | The country when nothing else knows (development) |
| `CONTEXT_TTL_SECONDS` | `3600` | How long browsers cache `GET /v1/context` |
| `RATE_LIMIT_PER_IP`, `RATE_LIMIT_PER_SITE` | | Requests per window, e.g. `600/1m` (`s`, `m`, `h`) |
| `RETENTION_INTERVAL` | `1h` | How often expired records and fields are purged; `0` turns it off |

Durations are a number and a unit: `500ms`, `30s`, `5m`, `1h`, `2d`. Empty variables count as
unset.

Without `TRUSTED_GEO_HEADERS`, `IPINFO_TOKEN` or `DEFAULT_COUNTRY`, every visitor's region is
unknown, so everyone gets the consent banner.

## Examples

**One process, Postgres, behind Cloudflare:**

```sh
STORE=postgres POSTGRES_URL=postgres://analytics@db/analytics \
SITES_FILE=/config/sites.json \
TRUSTED_GEO_HEADERS=cf-ipcountry,cf-ipcontinent TRUST_PROXY=1 \
HASH_SECRET=... RATE_LIMIT_PER_IP=600/1m \
consent-analytics-collector
```

**MongoDB, Redis and SQS, with IPinfo: the API and the worker scaled separately:**

```sh
# Shared by both
export STORE=mongodb MONGODB_URL=mongodb://mongo/analytics
export SITES_MONGODB_COLLECTION=analytics_sites
export QUEUE=sqs AWS_REGION=eu-west-1
export SQS_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/123456789012/analytics
export REDIS_URL=redis://redis:6379 TRUST_PROXY=1
export IPINFO_TOKEN=... HASH_SECRET=...

# API instances, behind the load balancer
MODE=api DELIVERY_CONSENT=direct RATE_LIMIT_PER_IP=600/1m \
  consent-analytics-collector

# Worker instances, no public traffic
MODE=worker WORKER_CONCURRENCY=4 consent-analytics-collector
```

Events are queued; consent records are written before the answer; the worker writes events in
bulk and runs retention under a Redis lock.

## Metrics

`/metrics` (Prometheus text format):

| Metric | Type | |
| --- | --- | --- |
| `consent_analytics_up` | gauge | 1 while the process runs |
| `consent_analytics_delivery_buffered{endpoint,mode}` | gauge | Records waiting in the in-process buffer |
| `consent_analytics_delivery_written_total{endpoint,mode}` | counter | Records written (or sent to the queue) by the buffer |
| `consent_analytics_delivery_failed_flushes_total{endpoint,mode}` | counter | Buffer writes that failed and were retried |
| `consent_analytics_delivery_lost_total{endpoint,mode}` | counter | Records given up on (at shutdown, or permanently failing) |
| `consent_analytics_worker_received_total` | counter | Messages received from the queue (worker) |
| `consent_analytics_worker_written_total` | counter | Messages written to the store |
| `consent_analytics_worker_retried_total` | counter | Messages scheduled for a retry |
| `consent_analytics_worker_dead_lettered_total` | counter | Messages dead-lettered |

Alert on `lost` and `dead_lettered` increasing, and on `buffered` staying high.

## Logs

JSON lines on stderr, one per entry, with `level`, `time`, `msg` and fields, for example:

```json
{"level":"info","time":"2026-11-17T18:57:54.197Z","msg":"collector started","url":"http://0.0.0.0:8787","mode":"api","store":"sqlite","queue":"none","delivery":{"events":"direct","consent":"direct"}}
```

Request-related entries carry the `requestId` (also sent as `X-Request-Id`). Request bodies
are never logged.

## As a library

`startCollector(config)` and `loadConfig(env)` are exported, for tests or your own entry
point:

```ts
import {
  loadConfig,
  startCollector,
} from '@clearideas/consent-analytics-collector'

const running = await startCollector(loadConfig({ ...process.env, PORT: '0' }))
console.log(running.url)
await running.stop()
```
