# Plan: production collector server

Status: **revision 5. All phases (0–8) complete** (see *Progress* at the end). Not yet published. Contract: `spec/openapi.yaml` (v1.1).

Revision 4 changes:
- **Delivery is decoupled from SQS.** Writes can be direct, buffered in-process, or go through any queue. Redis Streams and SQS are built in, and other queues plug in through one interface (section 7).
- **Store everything the browser sends** once consent is in place. This adds an event catalog covering every event type's fields and a typed, normalized projection alongside the raw props (section 6).
- **Server-side identity** from your own middleware (your validated cookie). This needs one opt-in browser and spec change so that cookies are actually sent (section 8).

---

## 0. Decisions

| Topic | Decision |
| --- | --- |
| Packaging | Separate packages in this repo. The browser package changes only for the opt-in credentials option (section 8). |
| Dependencies | The server library has **zero runtime and zero peer dependencies**. Adapters use the clients you already have. CI enforces this. |
| What's stored | **With consent: everything the browser sends, plus all useful server-side enrichment.** Without consent: only what the spec allows for `limited` events. Per-region policies control extras and retention. |
| Delivery | **`direct` · `buffered` (in-process) · `queued` (any queue)**. Redis Streams and SQS are built in, in-memory is for tests, and a 2-method interface covers any other queue. No queue product is privileged. |
| Identity | A generic `identify(request)` hook (configurable keys; defaults `userId`, `accountId`), fed by your existing auth middleware. Browser uses `credentials: 'include'` (same-site subdomain). Attached to consented (`full`) events and, optionally, consent records. Never attached to `limited` events. |
| Persistence | MongoDB first, then Postgres, DynamoDB, MySQL and SQLite. One interface, one conformance suite. |
| Redis | `@redis/client`/`redis`, ioredis and `@upstash/redis`, all through one small `RedisLike` interface. |
| Geo | IPinfo plus trusted CDN headers, in a chain. Unknown region means consent is required. |
| Regions | A data-policy config file: profiles per region, collection levels and retention. |
| Rules | Sanitize, don't reject. Consent records are never modified, only annotated. Consent `recordId` is deterministic, so retries don't duplicate records. |
| Platform | Express 5 (4 also tested), ESM only, Node ≥ 22, multiple instances. |

---

## 1. Current state (from the revision 1 review)

`sample-host/` is a sound reference, but it is tied to Hono, synchronous SQLite and static sites, reads the spec at runtime, and has no rate limiting, logging or retention. Probes showed:
1. A storage error returns `500 text/plain`.
2. An unsanitized `limited` event is accepted.
3. A contradictory consent record is accepted, and a retry stores it twice.

Additional findings in revision 4 (browser, `src/`):
- Cookies never reach the collector from `fetch` (`credentials: 'omit'` in `index.ts`, `tracking.ts` and `consent.ts`). `sendBeacon` always attaches them. Identity from cookies is therefore inconsistent today, and the spec forbids using it.
- Events repeat some fields: `title`/`pageTitle`, `timeSpent`/`timeSpentTotal`/`duration`, and `utm_*` both at top level and inside `attribution`.
- `auto_metrics` is sent twice per page with different fields and no marker saying which is which.
- Web vitals still report `FID`, which browsers have replaced with `INP`.

The server's normalized projection handles all of this (section 6). The browser clean-ups are listed as follow-ups and are not part of this work.

---

## 2. Dependency policy

**Installing the server library adds exactly one package to your app.**
- No runtime dependencies: validators are generated from the spec at build time (spike done). No peer dependencies: npm checks the version ranges of installed optional peers, so even unused adapters could break an install.
- **Bring your own client.** Adapters take your Mongo `Db`/Mongoose connection, Redis client, SQS/DynamoDB send functions, or `pg`/`mysql2` pool through small structural interfaces, and never import vendor code.
- Each adapter is a subpath and is loaded only when imported.
- **CI enforces it:** only `node:*` and relative imports are allowed, the dependency fields must be empty, and a pack-and-install test in an empty project asserts `npm ls --all --omit=dev` shows one package.

The standalone app (section 12) is a separate package and ships real drivers.

---

## 3. Packages and subpaths

```
server/      @clearideas/consent-analytics-server     library, zero deps (what you install)
collector/   @clearideas/consent-analytics-collector  standalone app + Docker image (ships drivers)
sample-host/ (private)                                dev playground, rebuilt on the library
src/         @clearideas/consent-analytics            browser package (+ opt-in credentials, section 8)
```

| Import | Contents |
| --- | --- |
| `…-server` | `createCollector`, types (including the typed event catalog), validation, rules, data policy, sites, geo chain, delivery modes, in-memory store, queue, limiter and cache |
| `…/express` · `…/node` · `…/fetch` | transport adapters (Express 5/4 without importing Express; `node:http`; Hono/Bun/Deno/Workers/Next.js) |
| `…/worker` | `runWorker`, `createIngestProcessor`, retention job |
| `…/redis` | `fromNodeRedis`, `fromIoredis`, `fromUpstash`; rate limiter, cache, lock, de-dupe; **`redisStreamQueue`** |
| `…/sqs` | `sqsQueue` (producer and consumer) |
| `…/ipinfo` | `ipinfoGeo` (global `fetch`) |
| `…/mongodb` · `…/postgres` · `…/dynamodb` · `…/mysql` · `…/sqlite` | stores, sites sources, indexes/migrations |
| `…/testing` | `runStoreConformance`, `runQueueConformance`, `runContractSuite` |

---

## 4. Architecture

```
 HTTP (Express / node:http / fetch)  ── CollectorRequest {method, path, query, headers, clientIp, raw, readBody}
   ▼
 route ► CORS ► rate limit ► media type ► body limit ► JSON ► site ► origin
       ► schema validation ► geo ► data policy profile ► identify(request)  [only if the site enables identity]
       ► rules (sanitize / annotate) ► normalize (event catalog) ► enrich (per profile)
       ► Delivery ─┬─ direct    → CollectorStore                        (write, then respond)
                   ├─ buffered  → in-process buffer → CollectorStore    (respond, write shortly after)
                   └─ queued    → IngestQueue → worker → CollectorStore  (respond once enqueued, or sooner)
   ▼
 202 / 201 / problem+json
```

Ports (injected): `SiteSource`, `GeoResolver`, `DataPolicy`, `identify`, `RateLimiter`, `Cache`, `Lock`, `IngestQueue`, `CollectorStore`, `Logger`, `hooks`.

HTTP behaviour follows the spec:
- CORS is echoed on every response.
- `text/plain` and JSON bodies are accepted.
- Body limits are enforced while streaming (`413`); other media types get `415`.
- Errors are problem+json.
- Store or queue failure returns `503` with `Retry-After`. This is safe because of `eventId` idempotency and deterministic consent `recordId`s.

---

## 5. Geo: IPinfo and CDN headers
- `chainGeo(trustedHeaderGeo([...]), ipinfoGeo({ token, timeoutMs: 150, cache }))`. No answer means unknown, which means consent is required.
- `ipinfoGeo` normalizes whatever your IPinfo plan returns: country, continent, region (mapped to ISO 3166-2 for the US, e.g. `US-CA`), city, postal code, coordinates, timezone, ASN/organisation, and VPN/proxy/hosting flags.
  - Cached under an HMAC of the IP, so no raw IPs are used as keys.
  - Timeouts and errors fall back to unknown.
  - Tested against recorded responses, plus a live test when `IPINFO_TOKEN` is set.
- `ipLookupGeo({ lookup })` accepts any other provider.
- `trustProxy` parses `X-Forwarded-For` safely; under Express it uses `req.ip`.
- `GET /v1/context` still returns only `country` and `continent`. Richer geo is stored according to the data policy.

---

## 6. What is stored: everything useful, once consent is in place

### 6.1 Principle
| Visitor state | Browser sends | Server stores |
| --- | --- | --- |
| `full` (statistics consent given, or no consent required and not refused) | All props (below) | **All props as sent**, plus a normalized projection, server enrichment (per profile) and identity (if enabled) |
| `limited` (consent required, not given) | Anonymous allowlisted fields only | The spec minimum: allowlisted fields, coarse geo and device. No IP, no identity, no persistent identifiers (spec MUST) |
| `none` policy, or explicit refusal in a strict region | Nothing | Nothing |

Per-region profiles can restrict `full` collection or shorten retention (for example, IP kept 30 days in one region and 180 days in another). The default (`balanced`) stores everything for `full` events in every region.

### 6.2 Event catalog: what the browser sends today
Every event has the envelope fields `eventId`, `name`, `occurredAt`, `sessionId`, `pageViewId`, `trackingCategory` and `consent {required, granted}`, plus `props`.

**Page context**, included in most automatic events: `url` (query reduced to an allowlist), `path`, `referrer`, `title`/`pageTitle`, `viewportBucket`, `deviceBucket`, `connectionType`.

**Full events also get:** the `userAgent` string, `timezone`, `language`, the browser's cached `country`/`continent`, and **first-touch attribution**. Attribution arrives both as `props.attribution` (`utm_*`, `ci_*`, `gclid`, `gbraid`, `wbraid`, `msclkid`, `fbclid`, `referrer`, `landingPath`, `landedAt`, `firstSeen`, `lastSeen`) and as top-level `utm_*`/`ci_*`/`gclid`/`msclkid`.

| Event | When | Event-specific fields |
| --- | --- | --- |
| `page_view` | load and each route change | page context |
| `page_exit` | leaving a page | `timeSpent`, `timeSpentTotal`, `clicks`, `keypresses`, `maxScrollDepth` + page context |
| `scroll_depth` | new max depth ≥ 25% | `depth`, `path` |
| `time_spent` | hidden after ≥ 30 s | `duration`, `timeSpent`, `clicks`, `keypresses`, `maxScrollDepth` + page context |
| `outbound_link_click` | click to another origin | `outboundUrl`, `outboundHost`, `outboundPath`, `outboundText`, `clicks`, `keypresses` + page context |
| `web_vital` | metric observed | `name` (`LCP`, `FID`, `CLS`, `FCP`, `TTFB`), `value` |
| `auto_metrics` (DOM ready) | DOMContentLoaded | `domContentLoadedTime`, `domInteractiveTime`, `totalResources`, `cachedResources`, `totalTransferSize`, `totalEncodedSize`, `totalDecodedSize`, `clicks`, `keypresses`, `maxScrollDepth` + page context |
| `auto_metrics` (load) | window load | `fullyLoadedTime`, `pageLoadTime` + page context |
| `error` | `trackError()` | `message` + caller props |
| custom (`sign_up`, …) | `trackEvent()` | caller props (any shape within the spec's limits) |

This catalog moves **into the spec** as documented per-event prop schemas. They are open (`additionalProperties` allowed), so they document rather than restrict. The server's TypeScript types are generated from them.

### 6.3 Storage model (per event)
```
envelope      eventId, siteKey, name, occurredAt, occurredAtCorrected, sentAt, receivedAt,
              sessionId, pageViewId, trackingCategory, consent, profile, origin, requestId
props         exactly as received (after limited-mode sanitizing only)      ← nothing the browser sent is lost
page          url, path, referrer, title, viewportBucket, deviceBucket, connectionType   (normalized)
attribution   utm_*, ci_*, click IDs, landingPath, landedAt, firstSeen, lastSeen       (de-duplicated)
metrics       per event type: engagement (timeSpent, clicks, keypresses, maxScrollDepth, depth),
              vital {name, value}, load timings {phase: 'dom'|'load', …}, outbound {url, host, path, text},
              error {message}
client        userAgent, timezone, language, clientCountry
server        ip (full/truncated/hashed per profile), geo {country…city, coords, postal, timezone},
              network {asn, org}, ua {browser, version, os, device, isBot}, acceptLanguage, gpc,
              privacyFlags {vpn, proxy, hosting}
identity      userId, accountId (+ allowed traits), source: 'server'                (full events only)
retention     retainUntil, ipRetainUntil, rawUserAgentRetainUntil
sanitized     list of repairs applied (if any)
```
- The **normalized projection** makes the data queryable without digging through raw props. It canonicalizes the duplicated fields, adds the `auto_metrics` phase, and flags bots using the user agent and IPinfo's hosting flag.
- **Raw props are always kept**, so custom events and any fields added to the browser later are stored without a server change.
- The SQL adapters store envelope columns, the typed projection as columns where useful, and `props` as JSON (`jsonb` in Postgres). The document stores (Mongo, DynamoDB) store the structure above directly.

### 6.4 Data policy (per-region profiles), summary
A JSON config with a published JSON Schema, validated at startup. It has:
- `regionSets` (countries, `@EU`/`@EEA` groups, US states),
- `profiles` (consent requirement, collection levels for `full` and `limited`, Global Privacy Control overrides, retention),
- ordered `rules` that map regions to profiles.

Collection levels:

| Item | Levels |
| --- | --- |
| `ip` | `none`, `truncated`, `hashed`, `full` |
| `geo` | `none` → `coords` |
| `network` | `none`, `asn`, `org` |
| `userAgent` | `none`, `device-type`, `parsed`, `raw` |
| `identity` | on / off |
| `clientProps` | `all` (default for `full`) or a denylist |

Fixed rules the config cannot override:
- The unknown region must require consent.
- `limited` events never carry IP, identity or persistent identifiers.
- Explicit refusal means `limited`.

Retention is per profile and per field group (`retainUntil`, `ipRetainUntil`, …). Enforcement: MongoDB TTL index, DynamoDB TTL, SQL purge jobs, and a field-purge job that runs under a Redis lock.

**Presets:**
- `strict`: today's behaviour.
- `balanced` (default): everything for `full`; GDPR regions require consent.
- `open`.

**Preset retention:**

| Region | Events | IP | Consent records |
| --- | --- | --- | --- |
| GDPR | 25 months (CNIL audience-measurement guidance) | 30 days | 5 years |
| Other | 36 months | 180 days | 5 years |

These are starting points to review with your counsel.

---

## 7. Delivery modes (no queue product is privileged)

| Mode | Response | Durability | Infrastructure | Use when |
| --- | --- | --- | --- | --- |
| `direct` | after the write | highest (the client retries on 503) | database only | simple deployments, consent records |
| `buffered` | immediate | buffer lost on a crash; flushed on shutdown | database only | fast intake without queue infrastructure |
| `queued` | after the enqueue (`durable`) or immediate (`fast`) | durable once enqueued | queue + worker | high volume, several API instances, writes kept off the API path |

- **Configurable per endpoint.** For example: `delivery: { events: { mode: 'queued', ack: 'fast' }, consent: { mode: 'direct' } }`.
- **`buffered`** batches by size and time (`maxBatch`, `flushMs`) and bounds its memory. When full it applies backpressure by writing directly for that request, or returns `503` (configurable). It reports buffer depth and flush failures, and retries with backoff.
- **Queue interface.** A queue adapter implements a producer and a consumer:
  ```ts
  interface IngestQueue {
    send(messages: IngestMessage[]): Promise<void>
    consume?: {
      receive(max: number, waitMs: number): Promise<Array<{ message: IngestMessage; handle: unknown }>>
      ack(handles: unknown[]): Promise<void>
      retry(handle: unknown, delayMs: number): Promise<void>
    }
  }
  ```
  Messages are versioned JSON envelopes (`kind`, `v`, `siteKey`, `receivedAt`, `requestId`, `profile`, `enrichment`, `identity`, `events`/`record`).
- **Built-in queues:**
  - **Redis Streams** (`redisStreamQueue`), using the Redis you already run:
    - `XADD` with `MAXLEN ~` trimming, and consumer groups via `XREADGROUP` on a dedicated blocking connection.
    - `XAUTOCLAIM` reclaims messages from crashed workers.
    - After N deliveries a message moves to a dead-letter stream.
    - Works with `@redis/client` and ioredis. Upstash's HTTP API can't do blocking reads, so it is not supported for queues.
  - **SQS** (`sqsQueue`): `SendMessageBatch`, long polling, visibility heartbeat, batch delete, and your queue's DLQ.
  - **In-memory**, for tests and a single process with `MODE=all`.
- **Other queues** (BullMQ, RabbitMQ, Kafka, Google Pub/Sub, NATS): implement the interface above, roughly 40 lines using your client. Recipes are documented, and `runQueueConformance` checks your adapter.
- **Worker:** `runWorker({ queue, store, concurrency, retention })`. It is the same for every queue:
  - Writes events from many messages in one bulk write.
  - Backs off while the store is down.
  - Dead-letters poison messages.
  - Runs the retention job under a Redis lock.
  - Drains in-flight work on SIGTERM.
  - Can run as a separate long-running process, or in the API process (`MODE=all`).
  - Redelivery is safe because of `(siteKey, eventId)` and `recordId` idempotency.
- In queued or buffered mode, `duplicates` in the response is `0`. Optional Redis edge de-dupe makes it accurate. The client ignores the counts.

---

## 8. Identity from your middleware

**Server side** (no browser trust involved). Identity is **generic**: you decide what it contains.
```js
app.use(optionalAuth)                   // must NOT reject anonymous requests on the collector path (see below)
app.use('/analytics', collectorMiddleware(collector, {
  identify: req => req.user ? { userId: req.user.id, accountId: req.user.accountId } : null,
}))
// collector config:
identity: {
  keys:   ['userId', 'accountId'],      // indexed, queryable (default: userId, accountId)
  traits: ['plan', 'role'],             // optional extras; stored in an identities collection, not on every event
  maxKeys: 16, maxValueLength: 256,
}
```
- `identify(req)` returns `Record<string, string | number | boolean> | null` (sync or async). The collector validates it against the `identity` config and drops unknown keys with a warning. Other users of the package can use `customerId`, `tenantId`, `orgId` or anything else. Stores index the configured `keys`: MongoDB compound indexes; in SQL, a JSON column plus generated, indexed columns per key.
- The hook receives the framework request (`req` in Express; `CollectorRequest.raw` for other transports). It runs **only for sites with `credentials: true`**.
- Identity is resolved once per request, at ingest, and travels inside the queue message.
- It is attached to **`full` events only**, and only where the profile allows `identity`. `limited` events never get it (spec MUST). Being logged in is not the same as consent.
- It is stored separately from `props`, with `source: 'server'`. A client-sent `props.userId` is kept as an untrusted prop and never promoted.
- Consent records are linked to identity (`consentRecords.identity: true`, recommended), which proves which account made which decision.
- **Auth middleware order:** your auth must be *optional* on the collector's path. If it sends `401` for anonymous visitors, their analytics (and consent records) would be blocked. Mount the collector after a "parse the cookie if present" step and before any "require login" step.

**Your setup: API on a subdomain of the same site, HttpOnly + Secure auth cookies.** This works with the browser's `credentials: 'include'`:
- `www.example.com` → `api.example.com` is *same-site*. Your cookie is sent whether it is `SameSite=Lax` or `Strict`, and third-party cookie blocking doesn't apply.
- A host-only cookie set by `api.example.com` is sent to `api.example.com`, so no `Domain` attribute is needed.
- `HttpOnly` is fine: the browser attaches the cookie, and neither the page nor the library can read it.
- `Secure` requires HTTPS. Most browsers make an exception for `localhost` during development.
- The server answers with `Access-Control-Allow-Origin: <exact origin>` and `Access-Control-Allow-Credentials: true` for sites with `credentials: true`.

**Why the browser has to change.** The client currently sends no cookies on `fetch`; only `sendBeacon` attaches them, which makes identity inconsistent, and the spec forbids using cookies. The change is opt-in:
- **Browser option** `credentials: 'omit' | 'same-origin' | 'include'`. The default stays `omit`. **Your deployment uses `include`.**
  - `same-origin`: the collector is mounted on the site's own origin (e.g. `www.example.com/analytics`). No CORS changes are needed.
  - `include`: the collector is on a subdomain of the same site (e.g. `api.example.com` for `www.example.com`). Your cookie needs `SameSite=Lax` or `None` and a suitable `Domain`.
- **Spec 1.1:** the sentence "MUST NOT use cookies" becomes "MUST NOT, unless the site enables credentials". For such sites, servers send `Access-Control-Allow-Credentials: true` with the exact origin. Without it, browsers reject credentialed responses, and the client would retry needlessly.
- **Safety:**
  - The origin allowlist already stops other sites from posting with your visitors' cookies. Every `POST` requires an allowed `Origin`.
  - A different *site* (another registrable domain) won't work reliably, because Safari and Firefox block third-party cookies. This is documented.
  - Sites without `credentials: true` ignore cookies even when `sendBeacon` attaches them.

---

## 9. Redis
One structural interface: `RedisLike.command(args)`, plus an optional `duplicate()` for blocking reads.

| Client | Wrapper | Maps to |
| --- | --- | --- |
| `@redis/client` / `redis` v4–v6 | `fromNodeRedis` | `sendCommand([...])`; scripts via `EVALSHA` with a fallback to `EVAL` |
| ioredis | `fromIoredis` | `call(...)` |
| `@upstash/redis` | `fromUpstash` | per-command methods; no blocking reads, so no Streams queue |

I checked the current releases: each client calls Lua scripts differently (`@redis/client` 6.3.1 `eval(script, {keys, arguments})`; ioredis 6.0.0 `eval(script, numKeys, …)`; `@upstash/redis` 1.39 `eval(script, keys, args)`). Hence one wrapper per client.

Uses:
- Rate limiting (Lua, `429` with `Retry-After`).
- Caches for sites and geo.
- Locks.
- Edge de-dupe.
- The Streams queue.
- Optional pub/sub for site invalidation.

Keys use hash tags, so everything works on Redis Cluster. Rate limiting fails open if Redis is down (configurable). CI runs the tests against real Redis with each client.

---

## 10. Storage adapters
| # | Adapter | Rationale | Also covers |
| --- | --- | --- | --- |
| 1 | MongoDB | your stack | Atlas; Mongoose via `connection.db` (may be passed lazily as a function) |
| 2 | PostgreSQL | most widely used; `jsonb` for props | RDS/Aurora, Supabase, Neon; `pg` and `postgres` clients |
| 3 | DynamoDB | fits AWS shops; per-item TTL | — |
| 4 | MySQL | common in existing stacks | MariaDB, Aurora MySQL, PlanetScale |
| 5 | SQLite | standalone, dev and tests; built into Node | — |

Every adapter:
- Supports idempotent batch inserts, idempotent consent by `recordId`, the retention fields, optional identity upserts and `health()`.
- Ships indexes/migrations as exported functions and SQL, with `autoMigrate` off by default.
- Passes the conformance suite against a real service in CI.

MongoDB specifics:
- `_id = "<siteKey>:<eventId>"`, with `insertMany({ordered: false})`; error 11000 means duplicate.
- TTL index on `retainUntil`.
- Indexes on `siteKey+receivedAt`, `siteKey+sessionId` and `siteKey+identity.userId`.

---

## 11. Rules and consent de-dupe (unchanged; summary)
- **Schema errors reject.** Rules repair events toward the more private reading and record what they changed in `sanitized`. Events that can't be allowed are dropped and reported in `rejected[]`.
- **Category consistency** (corrected while writing spec 1.1):
  - A `limited` event must have `consent.granted: false`. `consent.required` may be either value, because an explicit refusal where consent isn't required is also `limited`.
  - A `full` event must have `granted: true` or `required: false`.
  - Inconsistent events are repaired toward `limited`.
- **Consent records** are stored as received, with `annotations` (for example `decision-categories-mismatch` or `policy-version-stale`).
- **`recordId`** is a hash of the natural key (`siteKey`, `consentId`, `decidedAt`, `decision`, `categories`, `policyVersion`). A retry gets the same id without a database lookup; a new decision gets a new record.

## 12. Express and standalone (summary)
**Express 5 middleware**
- `app.use('/analytics', collectorMiddleware(collector, { identify }))`.
- Copes with body parsers and a global `cors()` mounted earlier.
- Protocol errors stay inside the middleware.

**Standalone collector** (CLI and Docker)
- `MODE=api|worker|all`.
- `DELIVERY_EVENTS` and `DELIVERY_CONSENT`: `direct|buffered|queued`.
- `QUEUE=redis|sqs`.
- `STORE=mongodb|postgres|dynamodb|mysql|sqlite|memory`.
- `DATA_POLICY=strict|balanced|open|path`.
- Plus `REDIS_URL`, `IPINFO_TOKEN`, `TRUST_PROXY`, `RATE_LIMIT_*` and `LOG_LEVEL`.
- Compatible with the sample host's environment variables.
- Graceful shutdown, JSON logs, `/v1/health`, and an opt-in `/readyz`.

## 13. Spec changes (1.0.0 → 1.1.0; additive; existing clients unaffected)
- `503` with `Retry-After` on the three endpoints.
- `accepted` means *accepted for processing*; `duplicates` MAY be 0 when writes are asynchronous. Consent `201` means *durably accepted*; servers SHOULD de-duplicate by the natural key.
- **Credentials:** sites MAY enable credentialed requests. For them, servers send `Access-Control-Allow-Credentials: true` and MAY resolve identity from cookies, for `full` events only. Everywhere else, the existing MUST NOTs stay.
- **Event catalog:** documented per-event prop schemas (open). Fix the table (`time_spent` also sends `duration`; `auto_metrics` has two phases).
- `x-limited-events` and `x-limited-fields`, with a root test keeping the browser's lists in sync.
- Servers MAY store more for `full` events according to their own policy; the `limited` MUSTs still apply.

## 14. Testing
- **Contract suite across transports and delivery modes:** fetch, node, Express 5 and Express 4 × direct, buffered and queued (in-memory queue). Every response is validated against the spec.
- **Queues:** `runQueueConformance` against Redis Streams (real Redis, both TCP clients) and SQS (ElasticMQ). Covers redelivery, crash reclaim (`XAUTOCLAIM`/visibility), dead-lettering and shutdown drain.
- **Catalog:**
  - Golden tests: real events captured from the browser client (via `test/client-host.test.ts`) stored in full, with the expected normalized projection.
  - Nothing the browser sends is dropped from `props` for `full` events.
  - Raw props are kept for custom events.
- **Identity:**
  - The hook runs only for identity-enabled sites; identity appears only on `full` events; spoofed `props.userId` is never promoted.
  - Credentialed CORS headers only for those sites.
  - The browser `credentials` option, tested end to end in Chromium (e2e) with a real cookie.
- **Data policy, IPinfo, Redis (three clients), stores (real services), and the dependency guarantees:** as in revision 3.
- **Browser:** existing unit, e2e and example suites stay green. The browser default (`omit`) is unchanged.

## 15. Phases
| # | Deliverable | Exit criteria |
| --- | --- | --- |
| 0 | Spec 1.1; `server/` scaffold (ESM, build, lint boundaries, CI); generated validators and catalog types; dependency-guarantee checks | One-package install test passes; repo `check` green |
| 1 | Core pipeline, fetch/node adapters, memory store, static sites, header geo; contract suite | Contract suite green (direct mode) |
| 2 | Rules, consent `recordId`, **event catalog normalization**, data-policy engine and presets | Probes 2 and 3 fixed; golden catalog tests green |
| 3 | Express middleware + **identity hook**; **browser `credentials` option** + credentialed CORS | Express contract suite green; Chromium cookie e2e green |
| 4 | **Delivery modes**: direct, buffered, queue interface, in-memory queue, `runWorker`; 503 handling | Contract suite green in all modes; probe 1 fixed |
| 5 | MongoDB store, sites, indexes, TTL, identity upserts; store conformance kit | Conformance green on real MongoDB |
| 6 | Redis (`RedisLike`, three clients): **Streams queue**, rate limit, caches, lock, de-dupe; `ipinfoGeo`; `trustProxy` | Queue conformance green on Redis; multi-instance tests green |
| 7 | SQS queue; Postgres, DynamoDB, MySQL and SQLite stores | Queue and store conformance green on each |
| 8 | Standalone collector + Docker; move `sample-host` and client test helpers onto the library; docs (BACKEND.md, guides for Express, identity, delivery/queues, Mongo, Redis, IPinfo and data policies); release workflows for both packages | Whole repo green (unit, e2e, examples); publish dry runs |

Phases 0–6 cover your stack: Express, Mongo, Redis (cache and queue), IPinfo and identity. SQS arrives in phase 7 as one queue option among others.

Browser follow-ups (separate work, not in this plan): report `INP` instead of `FID` (done after phase 8, with buffered observers); send an explicit `auto_metrics` phase; drop the duplicated props once the server's normalization is in place.

## 16. Before implementation

### 16.1 Decisions I will take unless you object
| Topic | Decision |
| --- | --- |
| Repo layout | `server/` and `collector/` follow the `sample-host/` pattern: own `package.json`, own lockfile, and the supply-chain gate runs per lockfile. `sample-host` uses the library through a `file:../server` link. No npm workspaces, so the browser package's lockfile and release flow stay as they are. |
| Versions | Spec `1.1.0`; server `0.1.0`; collector `0.1.0`; browser minor bump for the `credentials` option. Each package has its own changelog and release tag. |
| Node | Server engines `>=22.12` (ESM can be `require()`d); CI on 22 and 24. |
| Build | Rollup + `tsc` declarations, as in the root. The spec → validators/types generation is checked for drift. |
| Secrets | One `hashSecret` (a list, for rotation) for IP hashing and geo-cache keys. The daily salt is `HMAC(secret, date)`, so it is stateless and identical across instances, with no Redis needed. |
| Logging and metrics | Pass your logger (pino-compatible). `hooks` for metrics. The standalone app adds an optional Prometheus `/metrics` (zero deps). |
| Rate limits | Off in the library unless configured (your API may already have its own). On in the standalone app: 300 requests/min per IP per site, configurable per site. |
| Bots | Stored and flagged `isBot` (user agent + IPinfo hosting flag), with an option to drop them. |
| Read/reporting API | Out of scope. You query your database; indexes cover site + time, session, page view and the identity keys. |
| Browser changes | Only the opt-in `credentials` option (and its e2e test). Everything else in the browser is untouched. |

### 16.2 Resolved
1. **Data subject requests:** approved. `exportSubject`/`eraseSubject` by identity keys, `consentId` or `sessionId`. Erasure deletes events and identity records; consent records are kept but de-identified. Part of the store interface and the conformance suite (phase 5).
2. **Package names:** approved: `@clearideas/consent-analytics-server` and `@clearideas/consent-analytics-collector`. Docker registry (phase 8): GitHub Container Registry, opt-in with the `COLLECTOR_IMAGE_ENABLED` repository variable.
3. **Verification:** real services run locally without Docker or root (extracted packages, started by the test setup on free ports), and as service containers in CI.

### 16.3 Test services

| Service | Local source (verified in this environment) | CI |
| --- | --- | --- |
| Redis 7.0 | Ubuntu archive (`apt-get download` + `dpkg -x`). Streams, Lua, consumer groups and `XAUTOCLAIM` checked | `redis:7` service container |
| PostgreSQL 16 | Ubuntu archive, `initdb` as a non-root user | `postgres:16` |
| MySQL 8.0 | Ubuntu archive, `mysqld --initialize-insecure` | `mysql:8` |
| SQS + DynamoDB | `moto[server]` from PyPI. SQS batch send/receive, visibility, batch delete and DynamoDB conditional puts checked | moto, or ElasticMQ + DynamoDB Local |
| **MongoDB** | **Not obtainable here** (MongoDB's download servers are blocked). **Provided by you**: see below | `mongo:8` |
| Upstash | Hosted HTTP service; no local equivalent. Tested against a fake that follows its REST API | same |

- `server/scripts/test-services.mjs` downloads and extracts the packages into `server/.cache/services/`; `server/test/support/services.ts` (Vitest global setup) starts whichever services are available and passes their URLs to the tests.
- Service-backed suites **skip visibly** locally when a service is missing. With `REQUIRE_SERVICES=1`, which CI sets, a missing service is a **failure**, so nothing silently goes untested in CI.
- **MongoDB binary needed:** MongoDB Community Server **8.0.x, Linux x86_64, Ubuntu 24.04, `.tgz`** (`mongodb-linux-x86_64-ubuntu2404-8.0.<latest>.tgz`, from mongodb.com/try/download/community), placed in `/workspace/`. The test setup finds it extracted next to the repository (or use `MONGOD_BIN`). The required system libraries (`libssl3`, `libcrypto3`, `libcurl4`, `liblzma5`) are present. No `mongosh` is needed.
- Node drivers used in tests (`mongodb`, `mongoose`, `@redis/client`, `ioredis`, `@upstash/redis`, `pg`, `mysql2`, `@aws-sdk/client-sqs`, `@aws-sdk/client-dynamodb`, `express@5`, `express@4`) are **devDependencies of `server/` only**. They come from npm (reachable) and never appear in the published package's dependencies.
- This environment runs Node 22.21 (the root package asks for ≥ 22.22.3; npm only warns). CI covers current Node 22 and 24.

## 17. Progress

### Phase 0: done
**Spec 1.1** (`spec/openapi.yaml`, additive):
- `503` is declared on every endpoint.
- Asynchronous storage semantics, and consent retry de-duplication (SHOULD).
- Optional per-site *credentialed requests*.
- `limited` MUSTs: no IP and no identity.
- The event catalog: `x-event-catalog` plus props schemas and `FullEventContext`.
- `x-limited-tracking`.

**`server/` package:**
- ESM, Node ≥ 22.12, zero dependencies.
- Protocol module: `validate()`, limits, `LIMITED_TRACKING`, `EVENT_CATALOG`, and types for every schema, all generated from the spec.
- `npm run check` runs, in order: the drift check, type-check, tests with coverage, build, and the package check.

**Guarantees and how they're tested:**

| Guarantee | Test |
| --- | --- |
| Generated validators match Ajv exactly (spec examples, every single-point mutation of valid requests, edge cases, seeded random documents for every schema) | `server/test/generated.test.ts` |
| Vendored runtime helpers match the Ajv and ajv-formats originals | `server/test/generated.test.ts` |
| Exactly one package is installed; only relative and `node:` imports; ESM import and `require()` both work | `server/scripts/check-package.mjs`, run on the tarball. It was tested against injected violations: a declared dependency, and static, side-effect and dynamic imports. |
| Browser and server can't import each other | ESLint rules, plus `test/boundaries.test.ts` and `server/test/boundaries.test.ts`. Tested against injected violations. |
| The catalog matches what the browser really sends (every standard event produced by the library, with and without consent) | `test/spec-catalog.test.ts` |
| The browser's limited allowlists equal `x-limited-tracking` | `test/spec-catalog.test.ts` |
| Consumers type-check and run | Checked manually in a scratch project: TypeScript `NodeNext`, `Bundler` and `Node16` (ESM) with `skipLibCheck: false`; `require()` from CommonJS |

**CI:** a new `server` job (Node 22 and 24) runs the supply-chain gate on `server/package-lock.json`, then `npm ci` and `npm run check`.

**Found while doing phase 0:**
- `web_vital` events carry the full page context (`url`, `path`, …), not only `name`/`value`. The catalog test caught it, and it's documented in the spec.
- Events that are `limited` because the visitor explicitly refused, where consent isn't required, have `consent.required: false`. The spec text and the phase 2 consistency rule were corrected (section 11). The earlier rule would have wrongly "repaired" those events.

### Phase 1: done
- **Core** (`createCollector`):
  - All spec endpoints, CORS and preflight.
  - Media types; body limits enforced while streaming and via a `Content-Length` pre-check.
  - Validation with per-event rejections.
  - Idempotent events; deterministic consent `recordId`s (natural-key hash) with the original `recordedAt` returned on retries.
  - `503` with `Retry-After` on store or site-source failure.
  - A failed or missing geo lookup means an unknown region, so consent is required.
  - `404`/`405`/`500` as problem details; `X-Request-Id`; pluggable logger; an `onError` hook that can't break responses.
- **Transports:**
  - `/node`: handler usable as middleware, with `next()` fall-through and `trustProxy`; `createCollectorServer` with timeouts and graceful drain-then-close.
  - `/fetch`: handler with `basePath` and `getClientIp`.
- **Building blocks:** `memoryStore`, `staticSites`/`defineSite`, `trustedHeaderGeo`/`fixedGeo`/`chainGeo`, `regionPolicy`.
- **Store interface:** async and batch-oriented (`insertEvents`, `insertConsent`, optional `health`/`close`); the reader is separate and optional. `StoredEvent.consent` is nested.

**Tests:**

| Test | What it covers |
| --- | --- |
| `server/test/contract.test.ts` | 32 contract tests × 3 transports (fetch, `node:http`, `node:http` under a path), with responses checked against the spec. Deliberately introduced bugs (removing `Vary`, disabling consent de-dupe) were caught once per transport. |
| `server/test/adapters.test.ts` | Streamed bodies over the limit with no `Content-Length` (both transports; a deliberately introduced bug caught), `trustProxy`, mounting and fall-through, `next(error)`, graceful shutdown and its timeout |
| `server/test/support/store-conformance.ts` | Reusable store conformance (idempotency within and across batches, concurrency, copies, ordering, filters) |
| Root `test/client-host.test.ts` | The real browser library runs its six scenarios against both the sample host and the new server |

`server/scripts/check-package.mjs` now also runs a collector through both transports from the installed tarball. Consumer type-checks (NodeNext, Bundler; `skipLibCheck: false`) pass for the `/node` and `/fetch` subpaths.

**Test environment (sandbox):** the Playwright e2e suite (27 tests) passes with Chromium 153 from `@sparticuz/chromium` (documented in CONTRIBUTING). MongoDB 8.0.38 (provided) runs under bubblewrap with `--nounixsocket`; with the `mongodb` 7.8 driver, the replica set, TTL index and `insertMany({ ordered: false })` duplicate errors (code 11000) were checked, ready for phase 5.

### Phase 2: done
- **Data policy engine** (`src/policy`):
  - JSON Schema (`schemas/data-policy.schema.json`, shipped in the package) compiled into a standalone validator by the same generator.
  - Semantic checks: unknown profiles, region sets (nesting, cycles, built-in names), a required catch-all, the unknown region must require consent, `withoutConsent: none` only where consent is required. Every problem is reported at once.
  - Matching on country, ISO 3166-2 subdivision and sets; the first rule wins.
  - Presets: `strictDataPolicy` and `balancedDataPolicy` (the default). Both accept `consentCountries` and `noTrackingWithoutConsentCountries`; balanced also accepts `usPrivacyStates`.
  - **Deviation from the plan:** the third preset (`open`) was not shipped. It differed from `balanced` only in retention, and `balanced` already has an `open` profile. Edit a preset's document instead.
- **Enrichment** (`src/enrich`):
  - IP full, truncated or hashed (an HMAC with a daily key derived from `hashSecret`, stateless across instances).
  - A dependency-free user-agent parser (major versions, device, bot flag, Client Hints).
  - `Accept-Language`, `Sec-GPC`, and geo levels from country to coordinates; network by ASN or org; privacy flags.
  - The event category is an explicit argument: limited events can't get an IP address or privacy flags, even from a malformed collection.
- **Rules** (`src/rules`): the `standard`/`strict`/`off` presets and custom rules, implementing the corrected consistency rule (section 11).
  - limited props and URLs are sanitized; "nothing without consent" regions are honoured;
  - clock skew is corrected (`occurredAtCorrected`), with implausible times replaced;
  - sites can allow or deny event names;
  - `annotateConsent` adds `decision-categories-mismatch`, `partial-without-categories` and `policy-version-not-current`.
- **Normalization** (`src/normalize`): a typed projection from the event catalog. The generator now emits `CATALOG_PROPERTIES`, so the projection can't fall behind the spec.
- **Stored shape:**
  - Events gain `occurredAtCorrected`, `profile`, the projection fields, `server`, `sanitized`, `retainUntil`, `ipRetainUntil` and `rawUserAgentRetainUntil`.
  - Consent records gain `profile`, `annotations` and `retainUntil`.
  - The `Geo` type gains region, subdivision, city, postal code, coordinates, timezone, ASN, org and privacy flags, all validated. `GET /v1/context` still returns only the country and continent.

**Tests:**

| Test | What it covers |
| --- | --- |
| `test/policy.test.ts` | Validation, matching, presets, context policy, durations |
| `test/enrich.test.ts` | IP forms including tricky IPv6 spellings; 18 real user agents and bots; languages; every collection level |
| `test/rules.test.ts` | Every rule in each preset; time correction; custom rules; annotations |
| `test/normalize.test.ts` | Per-event mappings, plus a check that every documented catalog property is mapped (80 cases; a deliberately removed mapping was caught) |
| `test/pipeline.test.ts` | End to end through a collector: balanced by region, GPC, downgrade, unknown region, consent annotations, strict, hashed IP, `clientProps.deny`, invalid policy at startup |
| `test/generated.test.ts` | Now also proves the policy validator is equivalent to Ajv (every single-point mutation of a complete and a minimal policy) |
| Root `test/spec-catalog.test.ts` | The server's projection uses every value the real browser library sends in standard events |

**Fix from the user's run:** the random-document equivalence test timed out at 5 s on a slower machine. Results are now collected and asserted once, instead of one assertion per document (0.8–1.7 s down to about 0.3 s under coverage), and the suite has a 30 s timeout. A deliberately introduced bug in the vendored helper was still caught.

### Phase 3: done
Decisions confirmed by the user before this phase:
- `balanced` is the default data policy.
- Unknown regions are treated as consent regions at ingest too.
- There is no `open` preset.

**Browser (`src/`):**
- `credentials` option (`omit` by default; `same-origin`; `include`) used by all three `fetch` calls.
- Also available as `data-credentials`, `analyticsCredentials` (Nuxt) and `VITE_ANALYTICS_CREDENTIALS` (Vite).
- Unit tests for each mapping.

**Server:**
- Per-site `credentials: true`. `SiteSource.isCredentialedOrigin` adds `Access-Control-Allow-Credentials: true` (responses and preflights) only for origins of credentialed sites.
- Identity (`src/identity`):
  - Configurable keys (default `userId`, `accountId`) and traits.
  - Validated values; unknown names dropped with one warning each (names only, never values).
  - `identify` from the collector option or per request (`CollectorRequest.identify`, set by adapters).
  - A failing `identify` means anonymous.
- Identity is stored on full events where the profile's `identity` is true, and on consent records (`consentRecords`, default true). Never on limited events.
- Traits go to the optional `store.upsertIdentity` (memory store and conformance updated). A traits failure is reported via `onError`, but the batch still succeeds.
- Express middleware (`/express`): imports nothing from Express.
  - Handles bodies already parsed by `express.json`, `express.text` or `express.raw`, with size limits enforced.
  - If something else consumed the body: `400` plus a one-time warning.
  - Removes CORS headers left by an earlier `cors()`.
  - `req.ip` (`trust proxy`), `next()` fall-through, `next(error)`.

**Tests:**

| Test | What it covers |
| --- | --- |
| Contract suite | Now 5 transports (fetch, `node:http`, `node:http` under a path, Express 5, Express 4) × 32 tests. Under middleware, unknown paths go to the application's 404 (by design). |
| `test/express.test.ts` | 27 tests on Express 5 and 4: body parsers, global `cors()`, `trust proxy`, fall-through, errors, identity via an auth middleware. Three deliberately introduced bugs were each caught: CORS cleanup removed, the site `credentials` check bypassed, identity put on limited events. |
| `test/identity.test.ts` | Identity configuration and value validation |
| `e2e/identity.spec.ts` | In Chromium with a real `HttpOnly; Secure; SameSite=Lax` cookie across two same-site origins (`server/test/e2e/identity-host.ts`: Express 5 plus the library). See below. |

What `e2e/identity.spec.ts` shows:
- a signed-in visitor's events and consent record are identified, and traits are stored once;
- an anonymous visitor still works normally;
- without the browser option, events (sent with `sendBeacon`, which always sends cookies) are identified but the consent record (sent with `fetch`) is not. **Hence the documented rule: enable the browser option and the site setting together.** This went into the spec 1.1 text;
- a non-credentialed site ignores the cookie that `sendBeacon` attaches.

**CI:** the e2e job installs `server/` as well.

**Mistakes caught while verifying:**
- A stale `dist/` made the first e2e run misleading. `npm run test:e2e` builds first; I had invoked Playwright directly.
- The Express contract failures (unknown paths) were hidden at first because passes and failures were counted together. They're now counted separately.

### Phase 4: done
- **Messages** (`src/delivery/messages.ts`): a versioned JSON envelope (`events` with optional identity traits; `consent`) carrying finished records. `decodeMessage` rejects unknown versions, kinds and malformed records (a permanent failure).
- **Processor** (`createIngestProcessor`): the single write path for direct delivery, buffers and workers.
  - Events of all messages go in one bulk insert; if it fails, each message is retried on its own.
  - Identity traits are written after the events; a traits failure is reported but the message still succeeds.
  - Undecodable bodies fail permanently.
- **Sinks** (`src/delivery/sinks.ts`): `direct`, `buffered` and `queued` (`durable`/`fast`).
  - Buffers are bounded, with `whenFull: direct | durable` (backpressure, the default) or `reject` (503).
  - Failed writes are retried with exponential backoff, in order; permanently failing messages are dropped and logged.
  - `collector.close()` flushes (`flushTimeoutMs`); `collector.stats()`.
  - The store is optional when both endpoints are queued; the operation names in 503 errors and `onError` are `store.*`, `queue.send` or `delivery.*`.
- **Queue interface** (`IngestQueue`, bodies are strings) and `memoryQueue()`: visibility timeout, attempts, receipts (stale acks are ignored), delayed retry, dead letters, long polling and abort.
- **Worker** (`runWorker`):
  - long polling, bulk writes, acks;
  - retries with growing delays, dead-lettering after `maxAttempts` or at once for undecodable messages;
  - pauses receiving during outages; survives queue receive, retry and ack failures;
  - `concurrency`; a graceful `stop()`; `stats()`.

**Deviations from the plan:**
- The worker and queue API are exported from the main entry point, not a `/worker` subpath. Everything is dependency-free, so a separate entry point gained nothing.
- The retention job moves to phase 5: it needs store-side purging (`purge`, the Mongo TTL index), which comes with the first persistent store.
- "Contract suite in all delivery modes" became a stronger check: the same traffic (valid, invalid, duplicate and retried events and consent records) through `direct`, `buffered`, `queued/durable` and `queued/fast` (with a worker) must produce **identical stored data**, with every response checked against the spec. Mode-specific semantics (counts, 503 on a full buffer or failing queue) have their own tests. A deliberately introduced bug (queued consent silently dropped) was caught.

**Tests:**

| Test | What it covers |
| --- | --- |
| `test/support/queue-conformance.ts` | Reusable queue conformance (7 behaviors); `memoryQueue` passes it |
| `test/delivery-units.test.ts` | Envelope, processor (bulk writes, isolation, outage, traits, permanent failures), background writer (batching, capacity, ordered retry, close and deadline) |
| `test/delivery.test.ts` | Equivalence across modes; responses by mode; buffered backpressure and reject; queued durable (503) and fast (background retry, full buffer); store requirements; identity traits through a queue; worker behaviors (bulk, dead letters, outage recovery without duplicates, `maxAttempts`, `stop()`, queue failures, concurrency) |

### Phase 5: done
- **MongoDB** (`src/stores/mongodb.ts`, `/mongodb`):
  - **`mongoStore`:** structural driver interface (works with the native driver's `Db` and with `mongoose.connection.db`, including lazily); `_id = siteKey:eventId`; unordered bulk inserts counting duplicate-key errors (11000) as duplicates; BSON Dates for server times and retention fields; deterministic identity `_id`s with a retried upsert race; `health` pings.
  - **`ensureMongoIndexes`:** TTL indexes on `retainUntil` (events and consents), reporting indexes, and identity indexes (configurable keys).
  - **`mongoSites`:** invalid documents are logged and treated as unknown.
- **Sites:** `cachedSites` and `chainSites`.
- **Store interface:** optional `purge`, `exportSubject` and `eraseSubject` with shared matching rules (`src/storage/subject.ts`). Implemented by the memory and MongoDB stores, and part of the store conformance suite.
- **Retention** (`src/retention`): `retentionCutoffs` (the current policy's limits applied to stored records by profile), `purgeExpired`, and `startRetention` (interval, a `Lock` interface, failure logging). This is the job deferred from phase 4.
- **Found with the real server:** MongoDB rejects NUL characters in keys (and Postgres rejects them anywhere). Props are cleaned at ingest and flagged. A NUL in a consent `policyVersion` gets `400`, because records are evidence and are never modified.

**Tests:**
- `test/mongodb.test.ts` runs 19 tests against a real MongoDB 8.0.38 (started from the provided tarball by `test/support/services.ts`, with `ttlMonitorSleepSecs=1`):
  - the store conformance suite
  - indexes and TTL; BSON dates; keys containing dots or starting with `$`
  - the TTL monitor deleting expired documents
  - an unconnected database; Mongoose
  - the retention job with policy cutoffs
  - `mongoSites` with caching and chaining
  - a collector end to end: direct and queued-plus-worker delivery store identical documents, including identity and traits
- Two deliberately introduced adapter bugs were caught: duplicate-key errors not recognised, and profile cutoffs ignored.
- The `MONGODB_URL` path (now `TEST_MONGODB_URL`) was also checked: 18 pass and the fast-TTL test skips by design.
- `test/phase5-units.test.ts`: cache and chain behaviour, retention cutoffs, the lock, failure handling, NUL handling.
- **CI:** the server job runs a `mongo:8` service with `REQUIRE_SERVICES=1`.

### Phase 6: done
- **Rate limits** (`src/ratelimit`): the `RateLimiter` interface, `memoryRateLimiter()` (fixed windows, bounded keys), and the collector option `rateLimit: { limiter, perIp, perSite, onError }`. Over the limit: `429` with `Retry-After`. Keys are an HMAC of the IP (with `hashSecret`) or a hash, never the address. A failing limiter allows by default (`onError: 'reject'` answers `503`).
- **Caches** (`src/cache`): the `Cache` interface and `memoryCache()`; `cachedSites(..., { shared })` uses a shared cache as a second level.
- **Redis** (`/redis`): `fromNodeRedis`, `fromIoredis`, `fromUpstash` (a two-method `RedisLike`), and on top of it:
  - `redisRateLimiter` (one Lua round trip; optional in-memory fallback while Redis is down), `redisCache` (values marked, so foreign keys aren't misread), `redisLock` (owner-checked release);
  - `redisStreamQueue`: consumer group, `XAUTOCLAIM` for messages of crashed workers, delayed retries in a sorted set promoted by Lua, a dead-letter stream, `XACK` + `XDEL`. Blocking reads use duplicated connections, so they never delay other commands on the caller's client.
- **IPinfo** (`/ipinfo`): `ipinfoGeo` (classic and newer response formats, US and Canadian region codes, bearer token header, 150 ms timeout, local and shared caches keyed by HMAC, negative caching, non-public addresses skipped, warnings at most once a minute); `geoFromIpinfo`, `isNonPublicIp`.
- **`trustProxy`** accepts addresses and CIDR ranges (`src/http/cidr.ts`), validated when the handler is created.
- **Found while testing:**
  - **Older `cors` versions resume the request stream**, so a body could be consumed before the collector read it (data loss). The Express and `node:http` adapters now `pause()` the request on entry; the regression test uses the affected `cors` behavior. The devDependency moved to `cors` 2.8.6.
  - **node-redis and ioredis decode stream replies differently** (an object per stream, arrays, or a flattened RESP3 map). `streamEntries` normalizes all three; the queue conformance suite runs on both clients.
  - `check-package` scanned imports with a regular expression, which matched comments. It now uses TypeScript's `preProcessFile`; violations of each kind (static, side-effect, dynamic, `require`) were introduced on purpose and caught.

**Tests:** `test/redis.test.ts` (30, against Redis 7 with node-redis and ioredis; Upstash through a fake of its HTTP client), `test/phase6-units.test.ts` (14: limiter, caches, IPinfo parsing and resolver, CIDR), Express tests now 29. The CI server job gained Redis, Postgres, MySQL and moto services.

### Phase 7: done
- **SQS** (`/sqs`): `sqsQueue({ client, commands, queueUrl, deadLetterQueueUrl })`. The caller passes the SDK module, so nothing is imported. Batches of at most 10 entries and 256 KiB; `ApproximateReceiveCount` as attempts; retries by changing visibility; dead letters sent to a DLQ or left to the redrive policy.
- **Stores**, each passing the full store conformance suite against a real database:
  - **Postgres** (`/postgres`): `jsonb` documents with indexed columns; `migratePostgres` and `postgresMigrations()` (recorded in `<prefix>schema_migrations`).
  - **MySQL 8** (`/mysql`): the same design; `migrateMysql`, `mysqlMigrations()`.
  - **DynamoDB** (`/dynamodb`): one table (`pk`), documents as JSON strings, `expiresAt` TTL, identity attributes for lookups; `createDynamoTable`. Purges and data subject requests scan the table (documented).
  - **SQLite** (`/sqlite`): `node:sqlite` (Node 22.13+), for one process.
- **Found while testing:**
  - **SQS does not ignore stale receipts:** acking with the receipt of an earlier delivery can still delete the message. The queue conformance suite makes this a declared property (`staleReceiptsIgnored`); correctness relies on idempotent writes, which the worker already has.
  - **MySQL:** `affectedRows` for `INSERT ... ON DUPLICATE KEY UPDATE` depends on the `FOUND_ROWS` client flag, so duplicates are counted with a counter column (inserted = 2n − affected). `DATETIME` values were read in the server's time zone; they're now selected as text (tested under `TZ=America/New_York`).
  - **Postgres:** `doc #- '{a}' - 'b'` parses differently than it reads; the field-removal expressions are parenthesized.
  - The registry listed a `cors` release with an implausible date; versions are chosen by the `latest` dist-tag and then checked for age.

**Tests:** `test/sqs.test.ts` 11 (moto), `test/postgres.test.ts` 12, `test/mysql.test.ts` 12, `test/dynamodb.test.ts` 13 (moto), `test/sqlite.test.ts` 11. `check:package` imports every adapter from the installed tarball.

### Phase 8: done
- **Standalone collector** (`collector/`, `@clearideas/consent-analytics-collector`):
  - configuration from environment variables, validated all at once (`ConfigError` lists every problem; `--check`); empty values count as unset;
  - `MODE=api|worker|all`; every store and queue; sites from a file and/or MongoDB; data policy presets or a file; trusted headers, IPinfo, a default country; rate limits; Redis for limits, caches and the retention lock;
  - `/healthz`, `/readyz`, Prometheus `/metrics` (through `createCollectorServer({ routes })`, added to the library);
  - shutdown order: worker and retention, then HTTP (drain, flush buffers, close the store), then clients;
  - drivers loaded only when configured; the server library used only through its package entry points (ESLint rule);
  - `Dockerfile` (multi-stage, non-root, SQLite volume, health check); `docker-compose.yml` with a single-process setup and a `queued` profile (MongoDB + Redis, API and worker services); `scripts/smoke.mjs` for any running collector.
- **The sample host is built on the library.** Its own store, request handling and geo code are gone (`sample-host/src`: 548 lines removed, 178 added); it mounts `createCollector` with the strict data policy in Hono and keeps only the playground and the `/_dev` endpoints. The client-host tests run the browser library against it and against the library's defaults. The sample host's Dockerfile was replaced by the collector's.
- **A complete Express integration test** (`server/test/stack.test.ts`): Express 5 with optional cookie auth, Mongoose (store and sites), node-redis (rate limits, shared site and IPinfo caches, retention lock), SQS to a worker, and IPinfo (faked), all as in the server README's *A complete Express API*.
- **Found while testing:** `trustedHeaderGeo` read every configured header as a country, so with `TRUSTED_GEO_HEADERS=cf-ipcountry,cf-ipcontinent` a Tor visitor (`T1`) with `cf-ipcontinent: NA` was placed in Namibia (and `AS` in American Samoa). The previous sample host had the same bug. Continent headers are now never read as countries, and `EU`, `AP`, `A1`, `A2`, `O1`, `ZZ` are not countries.
- **CI:** a `collector` job (Node 22 and 24, all services, `REQUIRE_SERVICES=1`) and a `docker` job (build, smoke test, non-root, clean exit on `SIGTERM`). **Releases** by tag: `v*` (browser), `server-v*` (with all services), `collector-v*` (requires the server version on npm and pins it exactly); an optional GHCR image (`COLLECTOR_IMAGE_ENABLED`, multi-arch).
- **Docs:** server README (Redis, rate limits, IPinfo, SQS, stores, `trustProxy`, the complete Express example), collector README, BACKEND.md, sample-host README, CONTRIBUTING (test services, collector, releases), DEPENDENCIES, changelogs.

**Tests:** collector 18 (`test/config.test.ts` 12; `test/cli.test.ts` 6, each starting the collector as a process: SQLite with a restart, MongoDB + Redis in one process, Postgres + SQS as separate API and worker processes, MySQL, DynamoDB); server 627; root 392 (sample host 38); end-to-end 31 in Chromium; examples (7 frameworks).

**Not verified here:** building and running the Docker image (no Docker in this environment; the image's file layout was reproduced and run without Docker, and CI builds and smoke-tests the real image), real AWS (moto stands in for SQS and DynamoDB), the real IPinfo API (response formats from its documentation), and Upstash (a fake of its HTTP client).

### Follow-up: `npm test` from a fresh clone
- `npm test` in `server/` failed outside CI: the stack test opened a Mongoose connection while its suite was being collected, which throws when MongoDB isn't available (an unhandled error even though the suite was skipped). The connection now opens in `beforeAll`.
- The test-services setup no longer aborts the run when a service is unreachable or fails to start: it warns in one line and skips those tests (`REQUIRE_SERVICES=1` still fails). Service URLs are `TEST_*`-prefixed so an application's own `MONGODB_URL` is never used by tests that create and drop databases. `PATH` lookups no longer need `which`; Postgres and MySQL are also found on `PATH`.
- `scripts/ensure-deps.mjs` runs before `npm test` (root, `server/`, `collector/`): missing or outdated dependencies are installed with `npm ci`, including `sample-host/` for the root tests, and the collector builds `server/` when its `dist/` is stale. Verified on a fresh copy of the repository with no `node_modules` anywhere.
