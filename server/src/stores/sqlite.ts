// SQLite store on Node's built-in `node:sqlite` (Node >= 22.13; no native module): a single
// process, development, tests, small deployments.
//
//   const store = sqliteStore({ path: './data/analytics.db' })   // or ':memory:'
//
// Like the other SQL stores: each record is kept whole in a JSON `doc` column, with the fields
// queries, indexes and retention need as columns. Times are ISO 8601 text (UTC), which sorts
// correctly.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Identity } from '../identity/index.ts'
import { identityMatches, siteMatches } from '../storage/subject.ts'
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

export interface SqliteStoreOptions {
  /** Database file, or ':memory:'. The directory is created if needed. */
  path?: string
  /** Or an open database (then close() leaves it open). */
  database?: DatabaseSync
}

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '001_initial',
    sql: `
CREATE TABLE IF NOT EXISTS events (
  site_key TEXT NOT NULL, event_id TEXT NOT NULL, name TEXT NOT NULL, received_at TEXT NOT NULL,
  session_id TEXT NOT NULL, profile TEXT NOT NULL, identity TEXT, retain_until TEXT,
  ip_retain_until TEXT, raw_user_agent_retain_until TEXT, doc TEXT NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT, UNIQUE (site_key, event_id)
);
CREATE INDEX IF NOT EXISTS events_site_received ON events (site_key, received_at);
CREATE INDEX IF NOT EXISTS events_site_session ON events (site_key, session_id);
CREATE INDEX IF NOT EXISTS events_profile_received ON events (profile, received_at);
CREATE INDEX IF NOT EXISTS events_retain_until ON events (retain_until);
CREATE TABLE IF NOT EXISTS consents (
  record_id TEXT NOT NULL UNIQUE, site_key TEXT NOT NULL, consent_id TEXT NOT NULL, profile TEXT NOT NULL,
  recorded_at TEXT NOT NULL, retain_until TEXT, identity TEXT, doc TEXT NOT NULL,
  seq INTEGER PRIMARY KEY AUTOINCREMENT
);
CREATE INDEX IF NOT EXISTS consents_site_consent ON consents (site_key, consent_id);
CREATE INDEX IF NOT EXISTS consents_retain_until ON consents (retain_until);
CREATE TABLE IF NOT EXISTS identities (
  id TEXT NOT NULL UNIQUE, site_key TEXT NOT NULL, identity TEXT NOT NULL, traits TEXT NOT NULL,
  seen_at TEXT NOT NULL, first_seen_at TEXT NOT NULL, seq INTEGER PRIMARY KEY AUTOINCREMENT
);`,
  },
]

const identityId = (siteKey: string, identity: Identity) =>
  `${siteKey}:${JSON.stringify(Object.entries(identity).sort(([a], [b]) => (a < b ? -1 : 1)))}`

export interface SqliteStore extends CollectorStore, CollectorReader {
  upsertIdentity(record: StoredIdentity): Promise<void>
  purge(options: PurgeOptions): ReturnType<NonNullable<CollectorStore['purge']>>
  exportSubject(selector: SubjectSelector): ReturnType<NonNullable<CollectorStore['exportSubject']>>
  eraseSubject(selector: SubjectSelector): ReturnType<NonNullable<CollectorStore['eraseSubject']>>
  listIdentities(options?: ListOptions): Promise<StoredIdentity[]>
  readonly database: DatabaseSync
}

export function sqliteStore(options: SqliteStoreOptions = {}): SqliteStore {
  const owned = !options.database
  const path = options.path ?? ':memory:'
  if (owned && path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = options.database ?? new DatabaseSync(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  )
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map(
      r => r.name,
    ),
  )
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue
    db.exec('BEGIN')
    db.exec(migration.sql)
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
      migration.name,
      new Date().toISOString(),
    )
    db.exec('COMMIT')
  }

  const insertEvent = db.prepare(
    `INSERT INTO events (site_key, event_id, name, received_at, session_id, profile, identity, retain_until,
       ip_retain_until, raw_user_agent_retain_until, doc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (site_key, event_id) DO NOTHING`,
  )
  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const all = (sql: string, ...params: Array<string | number | null>) =>
    db.prepare(sql).all(...params) as any[]
  const run = (sql: string, ...params: Array<string | number | null>) =>
    Number(db.prepare(sql).run(...params).changes)

  const subjectEvents = (selector: SubjectSelector) =>
    all('SELECT event_id, site_key, doc FROM events ORDER BY seq')
      .map(row => ({ row, event: JSON.parse(row.doc) as StoredEvent }))
      .filter(
        ({ event }) =>
          siteMatches(event.siteKey, selector) &&
          (identityMatches(event.identity, selector.identity) ||
            (!!selector.sessionId && event.sessionId === selector.sessionId)),
      )
  const subjectConsents = (selector: SubjectSelector) =>
    all('SELECT record_id, doc FROM consents ORDER BY seq')
      .map(row => ({ row, record: JSON.parse(row.doc) as StoredConsent }))
      .filter(
        ({ record }) =>
          siteMatches(record.siteKey, selector) &&
          (identityMatches(record.identity, selector.identity) ||
            (!!selector.consentId && record.consentId === selector.consentId)),
      )
  const subjectIdentities = (selector: SubjectSelector) =>
    all('SELECT * FROM identities ORDER BY seq').filter(
      row =>
        siteMatches(row.site_key, selector) &&
        identityMatches(JSON.parse(row.identity), selector.identity),
    )
  const identityRecord = (row: any): StoredIdentity & { firstSeenAt: string } => ({
    siteKey: row.site_key,
    identity: JSON.parse(row.identity),
    traits: JSON.parse(row.traits),
    seenAt: row.seen_at,
    firstSeenAt: row.first_seen_at,
  })

  return {
    database: db,

    async insertEvents(events) {
      const inserted = transaction(() => {
        let count = 0
        for (const e of events) {
          count += Number(
            insertEvent.run(
              e.siteKey,
              e.eventId,
              e.name,
              e.receivedAt,
              e.sessionId,
              e.profile,
              e.identity ? JSON.stringify(e.identity) : null,
              e.retainUntil ?? null,
              e.ipRetainUntil ?? null,
              e.rawUserAgentRetainUntil ?? null,
              JSON.stringify(e),
            ).changes,
          )
        }
        return count
      })
      return { inserted, duplicates: events.length - inserted }
    },

    async insertConsent(record) {
      const changes = run(
        `INSERT INTO consents (record_id, site_key, consent_id, profile, recorded_at, retain_until, identity, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (record_id) DO NOTHING`,
        record.recordId,
        record.siteKey,
        record.consentId,
        record.profile,
        record.recordedAt,
        record.retainUntil ?? null,
        record.identity ? JSON.stringify(record.identity) : null,
        JSON.stringify(record),
      )
      if (changes) return { duplicate: false, recordedAt: record.recordedAt }
      const [row] = all('SELECT doc FROM consents WHERE record_id = ?', record.recordId)
      return {
        duplicate: true,
        recordedAt: row ? (JSON.parse(row.doc) as StoredConsent).recordedAt : record.recordedAt,
      }
    },

    async upsertIdentity(record) {
      run(
        `INSERT INTO identities (id, site_key, identity, traits, seen_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET identity = excluded.identity, traits = json_patch(identities.traits, excluded.traits), seen_at = excluded.seen_at`,
        identityId(record.siteKey, record.identity),
        record.siteKey,
        JSON.stringify(record.identity),
        JSON.stringify(record.traits),
        record.seenAt,
        record.seenAt,
      )
    },

    async purge({ now, profiles = [] }) {
      const nowIso = now.toISOString()
      const byProfile = (
        field: 'eventsBefore' | 'ipBefore' | 'rawUserAgentBefore' | 'consentsBefore',
        time: string,
      ) => {
        const parts = profiles.filter(p => p[field])
        return {
          sql: parts.map(() => ` OR (profile = ? AND ${time} < ?)`).join(''),
          params: parts.flatMap(p => [p.profile, p[field]!.toISOString()]),
        }
      }
      return transaction(() => {
        const e = byProfile('eventsBefore', 'received_at')
        const eventsDeleted = run(
          `DELETE FROM events WHERE retain_until <= ?${e.sql}`,
          nowIso,
          ...e.params,
        )
        const ip = byProfile('ipBefore', 'received_at')
        const ipsRemoved = run(
          `UPDATE events SET doc = json_remove(doc, '$.server.ip', '$.server.ipForm', '$.ipRetainUntil'), ip_retain_until = NULL
           WHERE json_extract(doc, '$.server.ip') IS NOT NULL AND (ip_retain_until <= ?${ip.sql})`,
          nowIso,
          ...ip.params,
        )
        const ua = byProfile('rawUserAgentBefore', 'received_at')
        const rawUserAgentsRemoved = run(
          `UPDATE events SET doc = json_remove(doc, '$.server.userAgent.raw', '$.rawUserAgentRetainUntil'), raw_user_agent_retain_until = NULL
           WHERE json_extract(doc, '$.server.userAgent.raw') IS NOT NULL AND (raw_user_agent_retain_until <= ?${ua.sql})`,
          nowIso,
          ...ua.params,
        )
        const c = byProfile('consentsBefore', 'recorded_at')
        const consentsDeleted = run(
          `DELETE FROM consents WHERE retain_until <= ?${c.sql}`,
          nowIso,
          ...c.params,
        )
        return { eventsDeleted, ipsRemoved, rawUserAgentsRemoved, consentsDeleted }
      })
    },

    async exportSubject(selector) {
      assertSubjectSelector(selector)
      return {
        events: subjectEvents(selector).map(({ event }) => event),
        consents: subjectConsents(selector).map(({ record }) => record),
        identities: subjectIdentities(selector).map(identityRecord),
      }
    },

    async eraseSubject(selector) {
      assertSubjectSelector(selector)
      return transaction(() => {
        const events = subjectEvents(selector)
        for (const { row } of events)
          run('DELETE FROM events WHERE site_key = ? AND event_id = ?', row.site_key, row.event_id)
        let consentsDeidentified = 0
        for (const { row, record } of subjectConsents(selector)) {
          if (!record.identity) continue
          delete record.identity
          run(
            'UPDATE consents SET identity = NULL, doc = ? WHERE record_id = ?',
            JSON.stringify(record),
            row.record_id,
          )
          consentsDeidentified++
        }
        const identities = subjectIdentities(selector)
        for (const row of identities) run('DELETE FROM identities WHERE id = ?', row.id)
        return {
          eventsDeleted: events.length,
          consentsDeidentified,
          identitiesDeleted: identities.length,
        }
      })
    },

    async health() {
      db.prepare('SELECT 1').get()
    },

    async close() {
      if (owned && db.isOpen) db.close()
    },

    async listEvents({ siteKey, limit = 500 } = {}) {
      const rows = siteKey
        ? all('SELECT doc FROM events WHERE site_key = ? ORDER BY seq LIMIT ?', siteKey, limit)
        : all('SELECT doc FROM events ORDER BY seq LIMIT ?', limit)
      return rows.map(row => JSON.parse(row.doc) as StoredEvent)
    },
    async listConsents({ siteKey, limit = 500 } = {}) {
      const rows = siteKey
        ? all('SELECT doc FROM consents WHERE site_key = ? ORDER BY seq LIMIT ?', siteKey, limit)
        : all('SELECT doc FROM consents ORDER BY seq LIMIT ?', limit)
      return rows.map(row => JSON.parse(row.doc) as StoredConsent)
    },
    async listIdentities({ siteKey, limit = 500 } = {}) {
      const rows = siteKey
        ? all('SELECT * FROM identities WHERE site_key = ? ORDER BY seq LIMIT ?', siteKey, limit)
        : all('SELECT * FROM identities ORDER BY seq LIMIT ?', limit)
      return rows.map(identityRecord)
    },
  }
}
