// MySQL (8.0.19+) / MariaDB-compatible store. Works with a mysql2 promise pool or connection
// (`query(sql, values)`), or anything with the same shape.
//
//   const store = mysqlStore({ db: pool })
//   await migrateMysql(pool)
//
// Like the Postgres store: each record is kept whole in a JSON `doc` column, with the fields
// that queries, indexes and retention need as columns. Times are UTC DATETIME(3).
// Duplicates are counted in a `duplicates` column (retries seen), which also makes the insert
// counts exact whatever the client's FOUND_ROWS setting.
import { createHash } from 'node:crypto'

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

export interface MysqlQueryable {
  query(sql: string, values?: unknown[]): Promise<[any, any]>
}

export interface MysqlStoreOptions {
  db: MysqlQueryable
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

/** Migrations in order, each a list of statements; each runs once. */
export function mysqlMigrations(
  prefix = 'analytics_',
): Array<{ name: string; statements: string[] }> {
  const t = tables(prefix)
  return [
    {
      name: '001_initial',
      statements: [
        `CREATE TABLE IF NOT EXISTS ${t.events} (
          site_key VARCHAR(64) NOT NULL,
          event_id VARCHAR(64) NOT NULL,
          name VARCHAR(64) NOT NULL,
          received_at DATETIME(3) NOT NULL,
          session_id VARCHAR(64) NOT NULL,
          tracking_category VARCHAR(16) NOT NULL,
          profile VARCHAR(64) NOT NULL,
          identity JSON NULL,
          retain_until DATETIME(3) NULL,
          ip_retain_until DATETIME(3) NULL,
          raw_user_agent_retain_until DATETIME(3) NULL,
          doc JSON NOT NULL,
          duplicates INT NOT NULL DEFAULT 0,
          seq BIGINT NOT NULL AUTO_INCREMENT,
          PRIMARY KEY (site_key, event_id),
          UNIQUE KEY seq (seq),
          KEY site_received (site_key, received_at),
          KEY site_session (site_key, session_id),
          KEY site_name_received (site_key, name, received_at),
          KEY profile_received (profile, received_at),
          KEY retain_until (retain_until),
          KEY ip_retain_until (ip_retain_until)
        ) CHARACTER SET utf8mb4`,
        `CREATE TABLE IF NOT EXISTS ${t.consents} (
          record_id VARCHAR(64) NOT NULL PRIMARY KEY,
          site_key VARCHAR(64) NOT NULL,
          consent_id VARCHAR(64) NOT NULL,
          profile VARCHAR(64) NOT NULL,
          recorded_at DATETIME(3) NOT NULL,
          retain_until DATETIME(3) NULL,
          identity JSON NULL,
          doc JSON NOT NULL,
          duplicates INT NOT NULL DEFAULT 0,
          seq BIGINT NOT NULL AUTO_INCREMENT,
          UNIQUE KEY seq (seq),
          KEY site_consent (site_key, consent_id),
          KEY profile_recorded (profile, recorded_at),
          KEY retain_until (retain_until)
        ) CHARACTER SET utf8mb4`,
        `CREATE TABLE IF NOT EXISTS ${t.identities} (
          id CHAR(64) NOT NULL PRIMARY KEY,
          site_key VARCHAR(64) NOT NULL,
          identity JSON NOT NULL,
          traits JSON NOT NULL,
          seen_at DATETIME(3) NOT NULL,
          first_seen_at DATETIME(3) NOT NULL,
          seq BIGINT NOT NULL AUTO_INCREMENT,
          UNIQUE KEY seq (seq),
          KEY site (site_key)
        ) CHARACTER SET utf8mb4`,
      ],
    },
  ]
}

export async function migrateMysql(
  db: MysqlQueryable,
  options: { prefix?: string } = {},
): Promise<string[]> {
  const t = tables(options.prefix)
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${t.migrations} (name VARCHAR(128) NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
  )
  const [rows] = await db.query(`SELECT name FROM ${t.migrations}`)
  const applied = new Set((rows as Array<{ name: string }>).map(row => row.name))
  const ran: string[] = []
  for (const migration of mysqlMigrations(options.prefix)) {
    if (applied.has(migration.name)) continue
    // MySQL DDL commits implicitly; statements are idempotent (IF NOT EXISTS) instead.
    for (const statement of migration.statements) await db.query(statement)
    await db.query(`INSERT IGNORE INTO ${t.migrations} (name) VALUES (?)`, [migration.name])
    ran.push(migration.name)
  }
  return ran
}

/** ISO 8601 to a UTC DATETIME(3) literal. */
const datetime = (value: string | Date | undefined | null) => {
  if (value === undefined || value === null) return null
  return new Date(value).toISOString().replace('T', ' ').replace('Z', '')
}
const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value))
const identityId = (siteKey: string, identity: Identity) =>
  createHash('sha256')
    .update(
      `${siteKey}:${JSON.stringify(Object.entries(identity).sort(([a], [b]) => (a < b ? -1 : 1)))}`,
    )
    .digest('hex')
const parse = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value)

export interface MysqlStore extends CollectorStore, CollectorReader {
  upsertIdentity(record: StoredIdentity): Promise<void>
  purge(options: PurgeOptions): ReturnType<NonNullable<CollectorStore['purge']>>
  exportSubject(selector: SubjectSelector): ReturnType<NonNullable<CollectorStore['exportSubject']>>
  eraseSubject(selector: SubjectSelector): ReturnType<NonNullable<CollectorStore['eraseSubject']>>
  listIdentities(options?: ListOptions): Promise<StoredIdentity[]>
}

export function mysqlStore(options: MysqlStoreOptions): MysqlStore {
  const { db } = options
  const t = tables(options.prefix)
  const affected = async (sql: string, values: unknown[]) =>
    ((await db.query(sql, values))[0] as { affectedRows: number }).affectedRows

  const subject = (selector: SubjectSelector, column: 'session_id' | 'consent_id') => {
    const clauses: string[] = []
    const values: unknown[] = []
    if (selector.identity && Object.keys(selector.identity).length) {
      clauses.push('JSON_CONTAINS(identity, CAST(? AS JSON))')
      values.push(JSON.stringify(selector.identity))
    }
    const other = column === 'session_id' ? selector.sessionId : selector.consentId
    if (other) {
      clauses.push(`${column} = ?`)
      values.push(other)
    }
    let where = `(${clauses.length ? clauses.join(' OR ') : 'FALSE'})`
    if (selector.siteKey) {
      where += ' AND site_key = ?'
      values.push(selector.siteKey)
    }
    return { where, values }
  }

  const purgeClause = (
    profiles: NonNullable<PurgeOptions['profiles']>,
    field: 'eventsBefore' | 'ipBefore' | 'rawUserAgentBefore' | 'consentsBefore',
    own: string,
    timeColumn: string,
    now: Date,
  ) => {
    const values: unknown[] = [datetime(now)]
    const clauses = [`${own} <= ?`]
    for (const p of profiles) {
      if (!p[field]) continue
      clauses.push(`(profile = ? AND ${timeColumn} < ?)`)
      values.push(p.profile, datetime(p[field]))
    }
    return { where: `(${clauses.join(' OR ')})`, values }
  }

  return {
    async insertEvents(events) {
      let inserted = 0
      for (let i = 0; i < events.length; i += 500) {
        const chunk = events.slice(i, i + 500)
        const values: unknown[] = []
        for (const event of chunk) {
          values.push(
            event.siteKey,
            event.eventId,
            event.name,
            datetime(event.receivedAt),
            event.sessionId,
            event.trackingCategory,
            event.profile,
            json(event.identity),
            datetime(event.retainUntil),
            datetime(event.ipRetainUntil),
            datetime(event.rawUserAgentRetainUntil),
            JSON.stringify(event),
          )
        }
        const rows = chunk
          .map(() => '(?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, CAST(? AS JSON))')
          .join(', ')
        // 1 affected row per insert, 2 per duplicate (its counter is increased).
        const count = await affected(
          `INSERT INTO ${t.events} (site_key, event_id, name, received_at, session_id, tracking_category, profile, identity,
             retain_until, ip_retain_until, raw_user_agent_retain_until, doc)
           VALUES ${rows} ON DUPLICATE KEY UPDATE duplicates = duplicates + 1`,
          values,
        )
        inserted += 2 * chunk.length - count
      }
      return { inserted, duplicates: events.length - inserted }
    },

    async insertConsent(record) {
      const count = await affected(
        `INSERT INTO ${t.consents} (record_id, site_key, consent_id, profile, recorded_at, retain_until, identity, doc)
         VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON)) ON DUPLICATE KEY UPDATE duplicates = duplicates + 1`,
        [
          record.recordId,
          record.siteKey,
          record.consentId,
          record.profile,
          datetime(record.recordedAt),
          datetime(record.retainUntil),
          json(record.identity),
          JSON.stringify(record),
        ],
      )
      if (count === 1) return { duplicate: false, recordedAt: record.recordedAt }
      const [rows] = await db.query(`SELECT doc FROM ${t.consents} WHERE record_id = ?`, [
        record.recordId,
      ])
      return {
        duplicate: true,
        recordedAt:
          (parse(rows[0]?.doc) as StoredConsent | undefined)?.recordedAt ?? record.recordedAt,
      }
    },

    async upsertIdentity(record) {
      await db.query(
        `INSERT INTO ${t.identities} (id, site_key, identity, traits, seen_at, first_seen_at)
         VALUES (?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?) AS new
         ON DUPLICATE KEY UPDATE identity = new.identity, traits = JSON_MERGE_PATCH(${t.identities}.traits, new.traits), seen_at = new.seen_at`,
        [
          identityId(record.siteKey, record.identity),
          record.siteKey,
          JSON.stringify(record.identity),
          JSON.stringify(record.traits),
          datetime(record.seenAt),
          datetime(record.seenAt),
        ],
      )
    },

    async purge({ now, profiles = [] }) {
      const events = purgeClause(profiles, 'eventsBefore', 'retain_until', 'received_at', now)
      const ips = purgeClause(profiles, 'ipBefore', 'ip_retain_until', 'received_at', now)
      const agents = purgeClause(
        profiles,
        'rawUserAgentBefore',
        'raw_user_agent_retain_until',
        'received_at',
        now,
      )
      const consents = purgeClause(profiles, 'consentsBefore', 'retain_until', 'recorded_at', now)
      const eventsDeleted = await affected(
        `DELETE FROM ${t.events} WHERE ${events.where}`,
        events.values,
      )
      const ipsRemoved = await affected(
        `UPDATE ${t.events} SET doc = JSON_REMOVE(doc, '$.server.ip', '$.server.ipForm', '$.ipRetainUntil'), ip_retain_until = NULL
         WHERE JSON_CONTAINS_PATH(doc, 'one', '$.server.ip') AND ${ips.where}`,
        ips.values,
      )
      const rawUserAgentsRemoved = await affected(
        `UPDATE ${t.events} SET doc = JSON_REMOVE(doc, '$.server.userAgent.raw', '$.rawUserAgentRetainUntil'), raw_user_agent_retain_until = NULL
         WHERE JSON_CONTAINS_PATH(doc, 'one', '$.server.userAgent.raw') AND ${agents.where}`,
        agents.values,
      )
      const consentsDeleted = await affected(
        `DELETE FROM ${t.consents} WHERE ${consents.where}`,
        consents.values,
      )
      return { eventsDeleted, ipsRemoved, rawUserAgentsRemoved, consentsDeleted }
    },

    async exportSubject(selector) {
      assertSubjectSelector(selector)
      const events = subject(selector, 'session_id')
      const consents = subject(selector, 'consent_id')
      const [[eventRows], [consentRows]] = await Promise.all([
        db.query(`SELECT doc FROM ${t.events} WHERE ${events.where} ORDER BY seq`, events.values),
        db.query(
          `SELECT doc FROM ${t.consents} WHERE ${consents.where} ORDER BY seq`,
          consents.values,
        ),
      ])
      let identities: StoredIdentity[] = []
      if (selector.identity && Object.keys(selector.identity).length) {
        const [rows] = await db.query(
          `SELECT site_key, identity, traits, CAST(seen_at AS CHAR) AS seen_at, CAST(first_seen_at AS CHAR) AS first_seen_at FROM ${t.identities} WHERE JSON_CONTAINS(identity, CAST(? AS JSON))${selector.siteKey ? ' AND site_key = ?' : ''} ORDER BY seq`,
          [JSON.stringify(selector.identity), ...(selector.siteKey ? [selector.siteKey] : [])],
        )
        identities = (rows as any[]).map(identityRecord)
      }
      return {
        events: (eventRows as any[]).map(row => parse(row.doc) as StoredEvent),
        consents: (consentRows as any[]).map(row => parse(row.doc) as StoredConsent),
        identities,
      }
    },

    async eraseSubject(selector) {
      assertSubjectSelector(selector)
      const events = subject(selector, 'session_id')
      const consents = subject(selector, 'consent_id')
      const eventsDeleted = await affected(
        `DELETE FROM ${t.events} WHERE ${events.where}`,
        events.values,
      )
      const consentsDeidentified = await affected(
        `UPDATE ${t.consents} SET identity = NULL, doc = JSON_REMOVE(doc, '$.identity') WHERE identity IS NOT NULL AND ${consents.where}`,
        consents.values,
      )
      let identitiesDeleted = 0
      if (selector.identity && Object.keys(selector.identity).length) {
        identitiesDeleted = await affected(
          `DELETE FROM ${t.identities} WHERE JSON_CONTAINS(identity, CAST(? AS JSON))${selector.siteKey ? ' AND site_key = ?' : ''}`,
          [JSON.stringify(selector.identity), ...(selector.siteKey ? [selector.siteKey] : [])],
        )
      }
      return { eventsDeleted, consentsDeidentified, identitiesDeleted }
    },

    async health() {
      await db.query('SELECT 1')
    },

    async close() {},

    async listEvents({ siteKey, limit = 500 } = {}) {
      const [rows] = siteKey
        ? await db.query(`SELECT doc FROM ${t.events} WHERE site_key = ? ORDER BY seq LIMIT ?`, [
            siteKey,
            limit,
          ])
        : await db.query(`SELECT doc FROM ${t.events} ORDER BY seq LIMIT ?`, [limit])
      return (rows as any[]).map(row => parse(row.doc) as StoredEvent)
    },
    async listConsents({ siteKey, limit = 500 } = {}) {
      const [rows] = siteKey
        ? await db.query(`SELECT doc FROM ${t.consents} WHERE site_key = ? ORDER BY seq LIMIT ?`, [
            siteKey,
            limit,
          ])
        : await db.query(`SELECT doc FROM ${t.consents} ORDER BY seq LIMIT ?`, [limit])
      return (rows as any[]).map(row => parse(row.doc) as StoredConsent)
    },
    async listIdentities({ siteKey, limit = 500 } = {}) {
      const [rows] = siteKey
        ? await db.query(
            `SELECT site_key, identity, traits, CAST(seen_at AS CHAR) AS seen_at, CAST(first_seen_at AS CHAR) AS first_seen_at FROM ${t.identities} WHERE site_key = ? ORDER BY seq LIMIT ?`,
            [siteKey, limit],
          )
        : await db.query(
            `SELECT site_key, identity, traits, CAST(seen_at AS CHAR) AS seen_at, CAST(first_seen_at AS CHAR) AS first_seen_at FROM ${t.identities} ORDER BY seq LIMIT ?`,
            [limit],
          )
      return (rows as any[]).map(identityRecord)
    },
  }
}

function identityRecord(row: any): StoredIdentity & { firstSeenAt: string } {
  // DATETIME(3) values are UTC.
  const iso = (value: unknown) =>
    value instanceof Date
      ? value.toISOString()
      : new Date(`${String(value).replace(' ', 'T')}Z`).toISOString()
  return {
    siteKey: row.site_key,
    identity: parse(row.identity),
    traits: parse(row.traits),
    seenAt: iso(row.seen_at),
    firstSeenAt: iso(row.first_seen_at),
  }
}
