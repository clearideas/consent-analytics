# Changelog: @clearideas/consent-analytics-collector

## Unreleased (0.1.0)

- A standalone collector on `@clearideas/consent-analytics-server`, configured with environment variables (`loadConfig`), validated all at once (every problem listed; `--check`).
- **Modes:** `api`, `worker` and `all`; `/healthz`, `/readyz` and Prometheus `/metrics` in every mode; graceful shutdown (worker and retention first, then HTTP with buffer flushing, then connections).
- **Stores:** SQLite (default), MongoDB, Postgres, MySQL, DynamoDB and in-memory, with automatic migrations (`AUTO_MIGRATE`).
- **Queues:** Redis Streams, SQS and in-memory; per-endpoint delivery (`DELIVERY_EVENTS`, `DELIVERY_CONSENT`).
- **Redis** (`REDIS_URL`) also shares rate limits, site and IPinfo caches, and the retention lock.
- Sites from a JSON file and/or a MongoDB collection; data policy presets or a policy file; trusted geo headers, IPinfo and a default country; `TRUST_PROXY` with CIDR ranges; per-IP and per-site rate limits.
- `startCollector(config)` for custom entry points and tests.
- Docker image (`collector/Dockerfile`): multi-stage, unprivileged user, SQLite volume, health check; `docker-compose.yml` with a single-process and a queued (MongoDB + Redis) setup.
