---
title: Stores
description: 'Store events and consent records in MongoDB, Postgres, MySQL, DynamoDB or SQLite, with your own client; the tables and collections, migrations, and example queries.'
---

# Stores

A store writes events and consent records. Each included store takes the client you already
have, never imports it, and passes the same conformance tests against a real database.

| Store | Import | Client | Schema | Expiry |
| --- | --- | --- | --- | --- |
| `mongoStore({ db })` | `/mongodb` | MongoDB driver `Db`, or `mongoose.connection.db` | `ensureMongoIndexes(store)` | TTL indexes, plus the purge job for fields |
| `postgresStore({ db })` | `/postgres` | `pg` Pool or Client (anything with `query(text, values)`) | `migratePostgres(db)` or `postgresMigrations()` | purge job |
| `mysqlStore({ db })` | `/mysql` | `mysql2/promise` pool | `migrateMysql(db)` or `mysqlMigrations()` | purge job |
| `dynamoStore({ client, commands, table })` | `/dynamodb` | `DynamoDBDocumentClient` and the `@aws-sdk/lib-dynamodb` module | `createDynamoTable(...)` or your infrastructure code | DynamoDB TTL, plus the purge job for fields |
| `sqliteStore({ path })` | `/sqlite` | built in (`node:sqlite`, Node.js 22.13+) | created on open | purge job |
| `memoryStore()` | main | none | none | purge job |

Every store also supports `purge` ([retention](./retention-and-privacy.md)), `exportSubject`
and `eraseSubject` ([data subject requests](./retention-and-privacy.md#data-subject-requests)),
identity traits (`upsertIdentity`), `health()` and `close()`.

**Which one?** Use the database you already run. MongoDB and Postgres have the richest
indexes for reporting. DynamoDB suits write-heavy, serverless setups; its purge and data
subject requests scan the table. SQLite is for a single process (the standalone collector's
default, development, small sites). The memory store is for tests.

## Writes are idempotent

- Events are unique by `(siteKey, eventId)`: a repeat, also within one batch, counts as a
  duplicate, not an error.
- Consent records are unique by `recordId`, which the collector derives from the record's
  contents: a retried record is stored once, and the answer carries the original
  `recordedAt`.
- A store throws on infrastructure failures; the collector then answers `503` with
  `Retry-After`, and browsers retry.

## MongoDB

```ts
import mongoose from 'mongoose'
import {
  ensureMongoIndexes,
  mongoStore,
} from '@clearideas/consent-analytics-server/mongodb'

const store = mongoStore({ db: () => mongoose.connection.db })
// or with the driver: mongoStore({ db: client.db('analytics') })

// idempotent
await ensureMongoIndexes(store, { identityKeys: ['userId', 'accountId'] })
```

- **Bring your own connection.** A function is fine: Mongoose connects lazily, and while it
  isn't connected, writes fail and the collector answers `503`. The store never closes your
  connection.
- **Collections** (names configurable with `collections: { events, consents, identities }`):

  | Collection | `_id` | Contents |
  | --- | --- | --- |
  | `analytics_events` | `<siteKey>:<eventId>` | The [stored event](./stored-data.md#events) |
  | `analytics_consents` | `recordId` | The [stored consent record](./stored-data.md#consent-records) |
  | `analytics_identities` | site and identity keys | Traits per identity |

  Server times (`receivedAt`, `occurredAtCorrected`, `recordedAt`) and retention dates are
  BSON Dates; browser times (`occurredAt`, `sentAt`, `decidedAt`) stay strings, since they
  aren't trusted.
- **`ensureMongoIndexes`** creates indexes for site and time, session, event name, profile
  and your identity keys, and **TTL indexes on `retainUntil`**, so MongoDB deletes expired
  events and consent records itself. Run it at startup or in your migrations.
- Keys containing dots or starting with `$` are fine in props (MongoDB 5+).
- Tested with MongoDB 8.0, the 7.8 driver and Mongoose 9.

Example queries:

```js
// Page views per day
db.analytics_events.aggregate([
  { $match: { siteKey: 'my-site', name: 'page_view' } },
  {
    $group: {
      _id: { $dateTrunc: { date: '$receivedAt', unit: 'day' } },
      views: { $sum: 1 },
    },
  },
  { $sort: { _id: 1 } },
])

// Top pages in the last 30 days
db.analytics_events.aggregate([
  {
    $match: {
      siteKey: 'my-site',
      name: 'page_view',
      receivedAt: { $gte: new Date(Date.now() - 30 * 864e5) },
    },
  },
  { $group: { _id: '$page.path', views: { $sum: 1 } } },
  { $sort: { views: -1 } },
  { $limit: 20 },
])

// Current consent decision per visitor
db.analytics_consents.aggregate([
  { $match: { siteKey: 'my-site' } },
  { $sort: { recordedAt: 1 } },
  { $group: { _id: '$consentId', decision: { $last: '$decision' } } },
  { $group: { _id: '$decision', visitors: { $sum: 1 } } },
])
```

## Postgres

```ts
import pg from 'pg'
import {
  migratePostgres,
  postgresStore,
} from '@clearideas/consent-analytics-server/postgres'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
// idempotent; records applied migrations
await migratePostgres(pool)
// prefix: 'analytics_' by default
const store = postgresStore({ db: pool })
```

Tables (`<prefix>events`, `<prefix>consents`, `<prefix>identities`,
`<prefix>schema_migrations`): the whole record in a `jsonb` column `doc`, and the fields used
for filtering as columns.

| Table | Columns |
| --- | --- |
| `analytics_events` | `site_key`, `event_id` (primary key together), `name`, `received_at` (`timestamptz`), `session_id`, `tracking_category`, `profile`, `identity` (`jsonb`), `retain_until`, `ip_retain_until`, `raw_user_agent_retain_until`, `doc` (`jsonb`), `seq` |
| `analytics_consents` | `record_id` (primary key), `site_key`, `consent_id`, `profile`, `recorded_at`, `retain_until`, `identity`, `doc`, `seq` |
| `analytics_identities` | `id`, `site_key`, `identity`, `traits`, `seen_at`, `first_seen_at`, `seq` |

Indexes cover site and time, session, name, profile, retention dates and identity (GIN).
`postgresMigrations(prefix)` returns the SQL, if you prefer to run it with your own migration
tool. Tested with PostgreSQL 16 and `pg` 8.

```sql
-- Page views per day
select date_trunc('day', received_at) as day, count(*)
from analytics_events
where site_key = 'my-site' and name = 'page_view'
group by 1 order by 1;

-- Acquisition: first-touch source of full events
select doc->'attribution'->>'utm_source' as source, count(distinct session_id) as sessions
from analytics_events
where site_key = 'my-site' and name = 'page_view' and tracking_category = 'full'
group by 1 order by 2 desc;

-- Consent decisions by profile
select profile, doc->>'decision' as decision, count(*)
from analytics_consents where site_key = 'my-site'
group by 1, 2;
```

## MySQL

```ts
import mysql from 'mysql2/promise'
import {
  migrateMysql,
  mysqlStore,
} from '@clearideas/consent-analytics-server/mysql'

const pool = mysql.createPool({
  uri: process.env.MYSQL_URL,
  connectionLimit: 10,
})
await migrateMysql(pool)
const store = mysqlStore({ db: pool })
```

The same tables and columns as Postgres, with `JSON` documents and `DATETIME(3)` times (UTC),
for MySQL 8. `mysqlMigrations(prefix)` returns the statements. Tested with MySQL 8.0 and
`mysql2` 3.

```sql
select doc->>'$.page.path' as path, count(*) as views
from analytics_events
where site_key = 'my-site' and name = 'page_view'
group by path order by views desc limit 20;
```

## DynamoDB

```ts
import * as ddb from '@aws-sdk/client-dynamodb'
import * as lib from '@aws-sdk/lib-dynamodb'
import {
  createDynamoTable,
  dynamoStore,
} from '@clearideas/consent-analytics-server/dynamodb'

const base = new ddb.DynamoDBClient({})
// once; fails if it exists
await createDynamoTable({ client: base, commands: ddb, table: 'analytics' })
const store = dynamoStore({
  client: lib.DynamoDBDocumentClient.from(base),
  commands: lib,
  table: 'analytics',
})
```

- **One table**, key `pk`: `E#<siteKey>#<eventId>` for events, `C#<recordId>` for consent
  records, `I#<hash>` for identities, with a `kind` attribute. Each record is stored as a JSON
  string in `doc`; `siteKey` and `seq` are attributes.
- `createDynamoTable` creates it with on-demand capacity and **TTL on `expiresAt`**, which the
  store sets from `retainUntil`. With your own infrastructure code, do the same.
- Inserts are conditional puts: idempotent per event and record. `concurrency` (default 10)
  limits parallel writes per batch.
- Purge, data subject requests and the readers **scan the table**. Schedule them off-peak;
  for reporting, export the table to S3 and query it with Athena, or stream it elsewhere.
- Tested against an emulator with the AWS SDK v3.

## SQLite

```ts
import { sqliteStore } from '@clearideas/consent-analytics-server/sqlite'

// the folder is created if needed
const store = sqliteStore({ path: './data/analytics.db' })
```

Tables `events`, `consents` and `identities`, with the record in a JSON text column `doc`.
One process only. Node.js prints an `ExperimentalWarning` for `node:sqlite` on some versions;
`--disable-warning=ExperimentalWarning` silences it.

```sh
sqlite3 data/analytics.db "select json_extract(doc, '$.page.path'), count(*) from events where name = 'page_view' group by 1"
```

## Writing your own store

A store implements two methods; the others are optional. See
[Custom adapters](./custom-adapters.md#stores).

```ts
interface CollectorStore {
  insertEvents(
    events: StoredEvent[],
  ): Promise<{ inserted: number; duplicates: number }>
  insertConsent(
    record: StoredConsent,
  ): Promise<{ duplicate: boolean; recordedAt: string }>
  upsertIdentity?(record: StoredIdentity): Promise<void>
  purge?(options: PurgeOptions): Promise<PurgeResult>
  exportSubject?(selector: SubjectSelector): Promise<SubjectData>
  eraseSubject?(selector: SubjectSelector): Promise<EraseResult>
  health?(): Promise<void>
  close?(): Promise<void>
}
```
