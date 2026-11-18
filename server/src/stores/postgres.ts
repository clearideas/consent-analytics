// PostgreSQL store. Works with anything that has a pg-style `query(text, values)`:
// a `pg` Pool or Client, or compatible clients.
//
//   const store = postgresStore({ db: pool })
//   await migratePostgres(pool)          // or run POSTGRES_MIGRATIONS with your own tooling
//
// Each record is kept whole in a jsonb `doc` column (round-trips exactly), with the fields that
// queries, indexes and retention need as columns. Times are timestamptz.
import type { Identity } from '../identity/index.ts'
import type {
  CollectorReader,
  CollectorStore,
  ListOptions,
  PurgeOptions,
  StoredConsent,
  StoredEvent,
  StoredIdentity,
  SubjectSelector,
} from '../storage/types.ts'
import { assertSubjectSelector } from '../storage/types.ts'

export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>
}

export interface PostgresStoreOptions {
  db: PgQueryable
  /** Table name prefix. Default "analytics_". */
  prefix?: string
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,40}$/

function tables(prefix = 'analytics_') {
  if (!IDENTIFIER.test(prefix)) throw new Error(`Invalid table prefix "${prefix}"`)
  return {
    events: `${prefix}events`,
    consents: `${prefix}consents`,
    identities: `${prefix}identities`,
    migrations: `${prefix}schema_migrations`,
  }
}

/** Migrations in order; each runs once (recorded in <prefix>schema_migrations). */
export function postgresMigrations(prefix = 'analytics_'): Array<{ name: string; sql: string }> {
  const t = tables(prefix)
  return [
    {
      name: '001_initial',
      sql: `
CREATE TABLE IF NOT EXISTS ${t.events} (
  site_key text NOT NULL,
  event_id text NOT NULL,
  name text NOT NULL,
  received_at timestamptz NOT NULL,
  session_id text NOT NULL,
  tracking_category text NOT NULL,
  profile text NOT NULL,
  identity jsonb,
  retain_until timestamptz,
  ip_retain_until timestamptz,
  raw_user_agent_retain_until timestamptz,
  doc jsonb NOT NULL,
  seq bigserial NOT NULL,
  PRIMARY KEY (site_key, event_id)
);
CREATE INDEX IF NOT EXISTS ${t.events}_site_received ON ${t.events} (site_key, received_at);
CREATE INDEX IF NOT EXISTS ${t.events}_site_session ON ${t.events} (site_key, session_id);
CREATE INDEX IF NOT EXISTS ${t.events}_site_name_received ON ${t.events} (site_key, name, received_at);
CREATE INDEX IF NOT EXISTS ${t.events}_profile_received ON ${t.events} (profile, received_at);
CREATE INDEX IF NOT EXISTS ${t.events}_retain_until ON ${t.events} (retain_until);
CREATE INDEX IF NOT EXISTS ${t.events}_ip_retain_until ON ${t.events} (ip_retain_until) WHERE ip_retain_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${t.events}_identity ON ${t.events} USING gin (identity jsonb_path_ops) WHERE identity IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${t.events}_seq ON ${t.events} (seq);
CREATE TABLE IF NOT EXISTS ${t.consents} (
  record_id text PRIMARY KEY,
  site_key text NOT NULL,
  consent_id text NOT NULL,
  profile text NOT NULL,
  recorded_at timestamptz NOT NULL,
  retain_until timestamptz,
  identity jsonb,
  doc jsonb NOT NULL,
  seq bigserial NOT NULL
);
CREATE INDEX IF NOT EXISTS ${t.consents}_site_consent ON ${t.consents} (site_key, consent_id);
CREATE INDEX IF NOT EXISTS ${t.consents}_profile_recorded ON ${t.consents} (profile, recorded_at);
CREATE INDEX IF NOT EXISTS ${t.consents}_retain_until ON ${t.consents} (retain_until);
CREATE INDEX IF NOT EXISTS ${t.consents}_identity ON ${t.consents} USING gin (identity jsonb_path_ops) WHERE identity IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${t.consents}_seq ON ${t.consents} (seq);
CREATE TABLE IF NOT EXISTS ${t.identities} (
  id text PRIMARY KEY,
  site_key text NOT NULL,
  identity jsonb NOT NULL,
  traits jsonb NOT NULL,
  seen_at timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL,
  seq bigserial NOT NULL
);
CREATE INDEX IF NOT EXISTS ${t.identities}_identity ON ${t.identities} USING gin (identity jsonb_path_ops);`,
    },
  ]
}

/** Apply pending migrations (idempotent). */
export async function migratePostgres(
  db: PgQueryable,
  options: { prefix?: string } = {},
): Promise<string[]> {
  const t = tables(options.prefix)
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${t.migrations} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  )
  const { rows } = await db.query(`SELECT name FROM ${t.migrations}`)
  const applied = new Set(rows.map(row => row.name))
  const ran: string[] = []
  for (const migration of postgresMigrations(options.prefix)) {
    if (applied.has(migration.name)) continue
    await db.query('BEGIN')
    try {
      await db.query(migration.sql)
      await db.query(`INSERT INTO ${t.migrations} (name) VALUES ($1) ON CONFLICT DO NOTHING`, [
        migration.name,
      ])
      await db.query('COMMIT')
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    }
    ran.push(migration.name)
  }
  return ran
}

const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value))
const identityId = (siteKey: string, identity: Identity) =>
  `${siteKey}:${JSON.stringify(Object.entries(identity).sort(([a], [b]) => (a < b ? -1 : 1)))}`

export interface PostgresStore extends CollectorStore, CollectorReader {
  upsertIdentity(record: StoredIdentity): Promise<void>
  purge(options: PurgeOptions): ReturnType<NonNullable<CollectorStore['purge']>>
  exportSubject(selector: SubjectSelector): ReturnType<NonNullable<CollectorStore['exportSubject']>>
  eraseSubject(selector: SubjectSelector): ReturnType<NonNullable<CollectorStore['eraseSubject']>>
  listIdentities(options?: ListOptions): Promise<StoredIdentity[]>
}

export function postgresStore(options: PostgresStoreOptions): PostgresStore {
  const { db } = options
  const t = tables(options.prefix)

  /** "(identity @> $n [OR session_id = $m])" for a subject, with its values. */
  const subject = (
    selector: SubjectSelector,
    column: 'session_id' | 'consent_id',
    start: number,
  ) => {
    const clauses: string[] = []
    const values: unknown[] = []
    if (selector.identity && Object.keys(selector.identity).length) {
      values.push(JSON.stringify(selector.identity))
      clauses.push(`identity @> $${start + values.length - 1}::jsonb`)
    }
    const other = column === 'session_id' ? selector.sessionId : selector.consentId
    if (other) {
      values.push(other)
      clauses.push(`${column} = $${start + values.length - 1}`)
    }
    if (selector.siteKey) values.push(selector.siteKey)
    const site = selector.siteKey ? ` AND site_key = $${start + values.length - 1}` : ''
    return { where: `(${clauses.length ? clauses.join(' OR ') : 'false'})${site}`, values }
  }

  const profileClauses = (
    profiles: NonNullable<PurgeOptions['profiles']>,
    field: 'eventsBefore' | 'ipBefore' | 'rawUserAgentBefore' | 'consentsBefore',
    timeColumn: string,
    values: unknown[],
  ) =>
    profiles
      .filter(p => p[field])
      .map(p => {
        values.push(p.profile, p[field])
        return `(profile = $${values.length - 1} AND ${timeColumn} < $${values.length})`
      })

  return {
    async insertEvents(events) {
      let inserted = 0
      // Chunks keep the statement well under PostgreSQL's 65 535 parameters.
      for (let i = 0; i < events.length; i += 1000) {
        const chunk = events.slice(i, i + 1000)
        const values: unknown[] = []
        const rows = chunk.map(event => {
          values.push(
            event.siteKey,
            event.eventId,
            event.name,
            event.receivedAt,
            event.sessionId,
            event.trackingCategory,
            event.profile,
            json(event.identity),
            event.retainUntil ?? null,
            event.ipRetainUntil ?? null,
            event.rawUserAgentRetainUntil ?? null,
            JSON.stringify(event),
          )
          const n = values.length - 12
          return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8}::jsonb, $${n + 9}, $${n + 10}, $${n + 11}, $${n + 12}::jsonb)`
        })
        const result = await db.query(
          `INSERT INTO ${t.events} (site_key, event_id, name, received_at, session_id, tracking_category, profile, identity,
             retain_until, ip_retain_until, raw_user_agent_retain_until, doc)
           VALUES ${rows.join(', ')} ON CONFLICT (site_key, event_id) DO NOTHING`,
          values,
        )
        inserted += result.rowCount ?? 0
      }
      return { inserted, duplicates: events.length - inserted }
    },

    async insertConsent(record) {
      const result = await db.query(
        `INSERT INTO ${t.consents} (record_id, site_key, consent_id, profile, recorded_at, retain_until, identity, doc)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb) ON CONFLICT (record_id) DO NOTHING`,
        [
          record.recordId,
          record.siteKey,
          record.consentId,
          record.profile,
          record.recordedAt,
          record.retainUntil ?? null,
          json(record.identity),
          JSON.stringify(record),
        ],
      )
      if (result.rowCount) return { duplicate: false, recordedAt: record.recordedAt }
      const { rows } = await db.query(
        `SELECT doc->>'recordedAt' AS recorded_at FROM ${t.consents} WHERE record_id = $1`,
        [record.recordId],
      )
      return { duplicate: true, recordedAt: rows[0]?.recorded_at ?? record.recordedAt }
    },

    async upsertIdentity(record) {
      await db.query(
        `INSERT INTO ${t.identities} AS existing (id, site_key, identity, traits, seen_at, first_seen_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $5)
         ON CONFLICT (id) DO UPDATE SET identity = EXCLUDED.identity, traits = existing.traits || EXCLUDED.traits, seen_at = EXCLUDED.seen_at`,
        [
          identityId(record.siteKey, record.identity),
          record.siteKey,
          JSON.stringify(record.identity),
          JSON.stringify(record.traits),
          record.seenAt,
        ],
      )
    },

    async purge({ now, profiles = [] }) {
      const run = async (
        sql: (clauses: string[], values: unknown[]) => string,
        field: Parameters<typeof profileClauses>[1],
        timeColumn: string,
        own: string,
      ) => {
        const values: unknown[] = [now]
        const clauses = [`${own} <= $1`, ...profileClauses(profiles, field, timeColumn, values)]
        return (await db.query(sql(clauses, values), values)).rowCount ?? 0
      }
      const eventsDeleted = await run(
        c => `DELETE FROM ${t.events} WHERE ${c.join(' OR ')}`,
        'eventsBefore',
        'received_at',
        'retain_until',
      )
      const ipsRemoved = await run(
        c => `UPDATE ${t.events} SET doc = ((doc #- '{server,ip}') #- '{server,ipForm}') - 'ipRetainUntil', ip_retain_until = NULL
              WHERE doc #> '{server,ip}' IS NOT NULL AND (${c.join(' OR ')})`,
        'ipBefore',
        'received_at',
        'ip_retain_until',
      )
      const rawUserAgentsRemoved = await run(
        c => `UPDATE ${t.events} SET doc = (doc #- '{server,userAgent,raw}') - 'rawUserAgentRetainUntil', raw_user_agent_retain_until = NULL
              WHERE doc #> '{server,userAgent,raw}' IS NOT NULL AND (${c.join(' OR ')})`,
        'rawUserAgentBefore',
        'received_at',
        'raw_user_agent_retain_until',
      )
      const consentsDeleted = await run(
        c => `DELETE FROM ${t.consents} WHERE ${c.join(' OR ')}`,
        'consentsBefore',
        'recorded_at',
        'retain_until',
      )
      return { eventsDeleted, ipsRemoved, rawUserAgentsRemoved, consentsDeleted }
    },

    async exportSubject(selector) {
      assertSubjectSelector(selector)
      const events = subject(selector, 'session_id', 1)
      const consents = subject(selector, 'consent_id', 1)
      const identityQuery = selector.identity && Object.keys(selector.identity).length
      const [eventRows, consentRows, identityRows] = await Promise.all([
        db.query(`SELECT doc FROM ${t.events} WHERE ${events.where} ORDER BY seq`, events.values),
        db.query(
          `SELECT doc FROM ${t.consents} WHERE ${consents.where} ORDER BY seq`,
          consents.values,
        ),
        identityQuery
          ? db.query(
              `SELECT * FROM ${t.identities} WHERE identity @> $1::jsonb${selector.siteKey ? ' AND site_key = $2' : ''} ORDER BY seq`,
              [JSON.stringify(selector.identity), ...(selector.siteKey ? [selector.siteKey] : [])],
            )
          : Promise.resolve({ rows: [] as any[] }),
      ])
      return {
        events: eventRows.rows.map(row => row.doc as StoredEvent),
        consents: consentRows.rows.map(row => row.doc as StoredConsent),
        identities: identityRows.rows.map(identityRecord),
      }
    },

    async eraseSubject(selector) {
      assertSubjectSelector(selector)
      const events = subject(selector, 'session_id', 1)
      const consents = subject(selector, 'consent_id', 1)
      const eventsDeleted =
        (await db.query(`DELETE FROM ${t.events} WHERE ${events.where}`, events.values)).rowCount ??
        0
      const consentsDeidentified =
        (
          await db.query(
            `UPDATE ${t.consents} SET identity = NULL, doc = doc - 'identity' WHERE identity IS NOT NULL AND ${consents.where}`,
            consents.values,
          )
        ).rowCount ?? 0
      let identitiesDeleted = 0
      if (selector.identity && Object.keys(selector.identity).length) {
        identitiesDeleted =
          (
            await db.query(
              `DELETE FROM ${t.identities} WHERE identity @> $1::jsonb${selector.siteKey ? ' AND site_key = $2' : ''}`,
              [JSON.stringify(selector.identity), ...(selector.siteKey ? [selector.siteKey] : [])],
            )
          ).rowCount ?? 0
      }
      return { eventsDeleted, consentsDeidentified, identitiesDeleted }
    },

    async health() {
      await db.query('SELECT 1')
    },

    // The pool belongs to the application.
    async close() {},

    async listEvents({ siteKey, limit = 500 } = {}) {
      const { rows } = siteKey
        ? await db.query(`SELECT doc FROM ${t.events} WHERE site_key = $1 ORDER BY seq LIMIT $2`, [
            siteKey,
            limit,
          ])
        : await db.query(`SELECT doc FROM ${t.events} ORDER BY seq LIMIT $1`, [limit])
      return rows.map(row => row.doc as StoredEvent)
    },
    async listConsents({ siteKey, limit = 500 } = {}) {
      const { rows } = siteKey
        ? await db.query(
            `SELECT doc FROM ${t.consents} WHERE site_key = $1 ORDER BY seq LIMIT $2`,
            [siteKey, limit],
          )
        : await db.query(`SELECT doc FROM ${t.consents} ORDER BY seq LIMIT $1`, [limit])
      return rows.map(row => row.doc as StoredConsent)
    },
    async listIdentities({ siteKey, limit = 500 } = {}) {
      const { rows } = siteKey
        ? await db.query(
            `SELECT * FROM ${t.identities} WHERE site_key = $1 ORDER BY seq LIMIT $2`,
            [siteKey, limit],
          )
        : await db.query(`SELECT * FROM ${t.identities} ORDER BY seq LIMIT $1`, [limit])
      return rows.map(identityRecord)
    },
  }
}

function identityRecord(row: any): StoredIdentity & { firstSeenAt: string } {
  const iso = (value: unknown) =>
    value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
  return {
    siteKey: row.site_key,
    identity: row.identity,
    traits: row.traits,
    seenAt: iso(row.seen_at),
    firstSeenAt: iso(row.first_seen_at),
  }
}
