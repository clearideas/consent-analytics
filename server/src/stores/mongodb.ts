// MongoDB store and site source. Works with the official driver's `Db` or Mongoose's
// `mongoose.connection.db`: pass yours (or a function returning it, since Mongoose connects
// lazily). Nothing is imported from the driver; the small interfaces below describe what is
// used.
//
//   const store = mongoStore({ db: () => mongoose.connection.db })
//   await ensureMongoIndexes(store)            // once, e.g. at deploy; or in your migrations
//
// Collections (names configurable): analytics_events, analytics_consents, analytics_identities.
// - Events: `_id` is "<siteKey>:<eventId>", so inserting is idempotent without another index.
// - Server-side times and retention dates are BSON Dates: TTL indexes on `retainUntil` delete
//   expired events and consent records automatically; purge() removes expired fields.
// - Client-side times (occurredAt, sentAt, decidedAt) stay strings: they are not trusted.
import type { Logger } from '../core/logger.ts'
import { consoleLogger, errorFields } from '../core/logger.ts'
import type { Identity } from '../identity/index.ts'
import type { Site, SiteSource } from '../sites/index.ts'
import { defineSite, SiteConfigError } from '../sites/index.ts'
import type {
  CollectorReader,
  CollectorStore,
  EraseResult,
  ListOptions,
  PurgeOptions,
  PurgeResult,
  StoredConsent,
  StoredEvent,
  StoredIdentity,
  SubjectData,
  SubjectSelector,
} from '../storage/types.ts'
import { assertSubjectSelector } from '../storage/types.ts'

// --- what is used of the driver ---------------------------------------------------------

type Doc = Record<string, any>

export interface MongoCursorLike {
  sort(spec: Record<string, 1 | -1>): MongoCursorLike
  limit(count: number): MongoCursorLike
  toArray(): Promise<Doc[]>
}

export interface MongoCollectionLike {
  insertMany(docs: Doc[], options: { ordered: boolean }): Promise<{ insertedCount: number }>
  insertOne(doc: Doc): Promise<unknown>
  findOne(filter: Doc, options?: Doc): Promise<Doc | null>
  find(filter: Doc, options?: Doc): MongoCursorLike
  updateOne(filter: Doc, update: Doc, options?: Doc): Promise<unknown>
  updateMany(filter: Doc, update: Doc): Promise<{ modifiedCount: number }>
  deleteMany(filter: Doc): Promise<{ deletedCount: number }>
  createIndex(spec: Record<string, 1 | -1>, options?: Doc): Promise<string>
}

export interface MongoDbLike {
  collection(name: string): MongoCollectionLike
  command?(command: Doc): Promise<unknown>
}

export type MongoDbSource = MongoDbLike | (() => MongoDbLike | null | undefined)

function resolveDb(source: MongoDbSource): MongoDbLike {
  const db = typeof source === 'function' ? source() : source
  if (!db) throw new Error('MongoDB is not connected yet')
  return db
}

const DUPLICATE_KEY = 11000

/** The write errors of a (bulk) write failure, or [] if it is not one. */
function writeErrorsOf(error: unknown): Array<{ code?: number }> {
  const e = error as { writeErrors?: unknown; code?: number }
  if (Array.isArray(e?.writeErrors)) return e.writeErrors as Array<{ code?: number }>
  if (e?.writeErrors && typeof e.writeErrors === 'object')
    return [e.writeErrors as { code?: number }]
  if (e?.code === DUPLICATE_KEY) return [e]
  return []
}

// --- documents ------------------------------------------------------------------------------

const EVENT_DATES = [
  'receivedAt',
  'occurredAtCorrected',
  'retainUntil',
  'ipRetainUntil',
  'rawUserAgentRetainUntil',
] as const
const CONSENT_DATES = ['recordedAt', 'retainUntil'] as const

const toDates = (record: Doc, fields: readonly string[]) => {
  const doc: Doc = { ...record }
  for (const field of fields) if (typeof doc[field] === 'string') doc[field] = new Date(doc[field])
  return doc
}
const fromDates = (doc: Doc, fields: readonly string[]) => {
  const record: Doc = { ...doc }
  delete record._id
  delete record._order
  for (const field of fields) {
    if (record[field] instanceof Date) record[field] = record[field].toISOString()
  }
  return record
}

/** A stable _id for an identity: site plus keys in sorted order. */
const identityId = (siteKey: string, identity: Identity) =>
  `${siteKey}:${JSON.stringify(Object.entries(identity).sort(([a], [b]) => (a < b ? -1 : 1)))}`

const identityFilter = (identity: Identity | undefined) =>
  identity && Object.keys(identity).length
    ? Object.fromEntries(Object.entries(identity).map(([key, value]) => [`identity.${key}`, value]))
    : undefined

// --- store ----------------------------------------------------------------------------------

export interface MongoStoreOptions {
  db: MongoDbSource
  collections?: { events?: string; consents?: string; identities?: string }
}

export interface MongoStore extends CollectorStore, CollectorReader {
  readonly collections: { events: string; consents: string; identities: string }
  readonly db: () => MongoDbLike
  upsertIdentity(record: StoredIdentity): Promise<void>
  purge(options: PurgeOptions): Promise<PurgeResult>
  exportSubject(selector: SubjectSelector): Promise<SubjectData>
  eraseSubject(selector: SubjectSelector): Promise<EraseResult>
  listIdentities(options?: ListOptions): Promise<StoredIdentity[]>
}

export function mongoStore(options: MongoStoreOptions): MongoStore {
  const names = {
    events: options.collections?.events ?? 'analytics_events',
    consents: options.collections?.consents ?? 'analytics_consents',
    identities: options.collections?.identities ?? 'analytics_identities',
  }
  const db = () => resolveDb(options.db)
  const events = () => db().collection(names.events)
  const consents = () => db().collection(names.consents)
  const identities = () => db().collection(names.identities)

  // Insertion order for listing (readers are for development and tests).
  let counter = 0
  const order = () => Date.now() * 1000 + (counter++ % 1000)

  const subjectEvents = (selector: SubjectSelector): Doc => {
    const or: Doc[] = []
    const byIdentity = identityFilter(selector.identity)
    if (byIdentity) or.push(byIdentity)
    if (selector.sessionId) or.push({ sessionId: selector.sessionId })
    return {
      ...(selector.siteKey ? { siteKey: selector.siteKey } : {}),
      $or: or.length ? or : [{ _id: null }],
    }
  }
  const subjectConsents = (selector: SubjectSelector): Doc => {
    const or: Doc[] = []
    const byIdentity = identityFilter(selector.identity)
    if (byIdentity) or.push(byIdentity)
    if (selector.consentId) or.push({ consentId: selector.consentId })
    return {
      ...(selector.siteKey ? { siteKey: selector.siteKey } : {}),
      $or: or.length ? or : [{ _id: null }],
    }
  }
  const subjectIdentities = (selector: SubjectSelector): Doc | undefined => {
    const byIdentity = identityFilter(selector.identity)
    return byIdentity
      ? { ...(selector.siteKey ? { siteKey: selector.siteKey } : {}), ...byIdentity }
      : undefined
  }
  const list = async (collection: MongoCollectionLike, filter: Doc, limit: number) =>
    collection.find(filter).sort({ _order: 1 }).limit(limit).toArray()

  return {
    collections: names,
    db,

    async insertEvents(batch) {
      if (!batch.length) return { inserted: 0, duplicates: 0 }
      const docs = batch.map(event => ({
        ...toDates(event, EVENT_DATES),
        _id: `${event.siteKey}:${event.eventId}`,
        _order: order(),
      }))
      try {
        const result = await events().insertMany(docs, { ordered: false })
        return { inserted: result.insertedCount, duplicates: 0 }
      } catch (error) {
        const writeErrors = writeErrorsOf(error)
        if (writeErrors.length && writeErrors.every(e => e.code === DUPLICATE_KEY)) {
          return { inserted: batch.length - writeErrors.length, duplicates: writeErrors.length }
        }
        throw error
      }
    },

    async insertConsent(record) {
      try {
        await consents().insertOne({
          ...toDates(record, CONSENT_DATES),
          _id: record.recordId,
          _order: order(),
        })
        return { duplicate: false, recordedAt: record.recordedAt }
      } catch (error) {
        if (!writeErrorsOf(error).some(e => e.code === DUPLICATE_KEY)) throw error
        const existing = await consents().findOne(
          { _id: record.recordId },
          { projection: { recordedAt: 1 } },
        )
        const recordedAt =
          existing?.recordedAt instanceof Date
            ? existing.recordedAt.toISOString()
            : record.recordedAt
        return { duplicate: true, recordedAt }
      }
    },

    async upsertIdentity(record) {
      const seenAt = new Date(record.seenAt)
      const update = {
        $set: {
          siteKey: record.siteKey,
          identity: record.identity,
          seenAt,
          ...Object.fromEntries(
            Object.entries(record.traits).map(([key, value]) => [`traits.${key}`, value]),
          ),
        },
        $setOnInsert: { firstSeenAt: seenAt, _order: order() },
      }
      const filter = { _id: identityId(record.siteKey, record.identity) }
      try {
        await identities().updateOne(filter, update, { upsert: true })
      } catch (error) {
        // Two concurrent upserts of a new identity: one loses the insert race; retry as update.
        if (!writeErrorsOf(error).some(e => e.code === DUPLICATE_KEY)) throw error
        await identities().updateOne(filter, update, { upsert: true })
      }
    },

    async purge({ now, profiles = [] }) {
      const byProfile = (
        field: 'eventsBefore' | 'ipBefore' | 'rawUserAgentBefore' | 'consentsBefore',
        time: string,
      ) =>
        profiles.filter(p => p[field]).map(p => ({ profile: p.profile, [time]: { $lt: p[field] } }))
      const [eventsDeleted, ipsRemoved, rawUserAgentsRemoved, consentsDeleted] = await Promise.all([
        events().deleteMany({
          $or: [{ retainUntil: { $lte: now } }, ...byProfile('eventsBefore', 'receivedAt')],
        }),
        events().updateMany(
          {
            'server.ip': { $exists: true },
            $or: [{ ipRetainUntil: { $lte: now } }, ...byProfile('ipBefore', 'receivedAt')],
          },
          { $unset: { 'server.ip': '', 'server.ipForm': '', ipRetainUntil: '' } },
        ),
        events().updateMany(
          {
            'server.userAgent.raw': { $exists: true },
            $or: [
              { rawUserAgentRetainUntil: { $lte: now } },
              ...byProfile('rawUserAgentBefore', 'receivedAt'),
            ],
          },
          { $unset: { 'server.userAgent.raw': '', rawUserAgentRetainUntil: '' } },
        ),
        consents().deleteMany({
          $or: [{ retainUntil: { $lte: now } }, ...byProfile('consentsBefore', 'recordedAt')],
        }),
      ])
      return {
        eventsDeleted: eventsDeleted.deletedCount,
        ipsRemoved: ipsRemoved.modifiedCount,
        rawUserAgentsRemoved: rawUserAgentsRemoved.modifiedCount,
        consentsDeleted: consentsDeleted.deletedCount,
      }
    },

    async exportSubject(selector) {
      assertSubjectSelector(selector)
      const identityQuery = subjectIdentities(selector)
      const [eventDocs, consentDocs, identityDocs] = await Promise.all([
        list(events(), subjectEvents(selector), 0),
        list(consents(), subjectConsents(selector), 0),
        identityQuery ? list(identities(), identityQuery, 0) : Promise.resolve([]),
      ])
      return {
        events: eventDocs.map(doc => fromDates(doc, EVENT_DATES) as StoredEvent),
        consents: consentDocs.map(doc => fromDates(doc, CONSENT_DATES) as StoredConsent),
        identities: identityDocs.map(doc => identityRecord(doc)),
      }
    },

    async eraseSubject(selector) {
      assertSubjectSelector(selector)
      const identityQuery = subjectIdentities(selector)
      const [eventsDeleted, consentsDeidentified, identitiesDeleted] = await Promise.all([
        events().deleteMany(subjectEvents(selector)),
        consents().updateMany(
          { ...subjectConsents(selector), identity: { $exists: true } },
          { $unset: { identity: '' } },
        ),
        identityQuery
          ? identities().deleteMany(identityQuery)
          : Promise.resolve({ deletedCount: 0 }),
      ])
      return {
        eventsDeleted: eventsDeleted.deletedCount,
        consentsDeidentified: consentsDeidentified.modifiedCount,
        identitiesDeleted: identitiesDeleted.deletedCount,
      }
    },

    async health() {
      const database = db()
      if (database.command) await database.command({ ping: 1 })
    },

    // The connection belongs to the application: nothing to close here.
    async close() {},

    async listEvents({ siteKey, limit = 500 } = {}) {
      const docs = await list(events(), siteKey ? { siteKey } : {}, limit)
      return docs.map(doc => fromDates(doc, EVENT_DATES) as StoredEvent)
    },
    async listConsents({ siteKey, limit = 500 } = {}) {
      const docs = await list(consents(), siteKey ? { siteKey } : {}, limit)
      return docs.map(doc => fromDates(doc, CONSENT_DATES) as StoredConsent)
    },
    async listIdentities({ siteKey, limit = 500 } = {}) {
      const docs = await list(identities(), siteKey ? { siteKey } : {}, limit)
      return docs.map(doc => identityRecord(doc))
    },
  }
}

function identityRecord(doc: Doc): StoredIdentity & { firstSeenAt?: string } {
  return {
    siteKey: doc.siteKey,
    identity: doc.identity,
    traits: doc.traits ?? {},
    seenAt: doc.seenAt instanceof Date ? doc.seenAt.toISOString() : doc.seenAt,
    ...(doc.firstSeenAt instanceof Date ? { firstSeenAt: doc.firstSeenAt.toISOString() } : {}),
  }
}

// --- indexes ----------------------------------------------------------------------------------

export interface MongoIndexOptions {
  /** Identity keys to index (match your collector's `identity.keys`). Default userId, accountId. */
  identityKeys?: readonly string[]
  /** Delete expired events and consent records automatically (TTL index on retainUntil). Default true. */
  ttl?: boolean
}

/**
 * Create the indexes the store and typical reports use. Idempotent: safe to run at every
 * deploy. Run it from your own migration tooling if you prefer.
 */
export async function ensureMongoIndexes(
  store: MongoStore,
  options: MongoIndexOptions = {},
): Promise<string[]> {
  const db = store.db()
  const events = db.collection(store.collections.events)
  const consents = db.collection(store.collections.consents)
  const identities = db.collection(store.collections.identities)
  const identityKeys = options.identityKeys ?? ['userId', 'accountId']
  const ttl = options.ttl !== false ? { expireAfterSeconds: 0 } : {}
  const created = await Promise.all([
    events.createIndex({ siteKey: 1, receivedAt: -1 }, { name: 'site_received' }),
    events.createIndex({ siteKey: 1, sessionId: 1 }, { name: 'site_session' }),
    events.createIndex({ siteKey: 1, name: 1, receivedAt: -1 }, { name: 'site_name_received' }),
    events.createIndex({ profile: 1, receivedAt: 1 }, { name: 'profile_received' }),
    events.createIndex({ _order: 1 }, { name: 'order' }),
    events.createIndex({ retainUntil: 1 }, { name: 'retain_until', ...ttl }),
    events.createIndex({ ipRetainUntil: 1 }, { name: 'ip_retain_until', sparse: true }),
    events.createIndex(
      { rawUserAgentRetainUntil: 1 },
      { name: 'raw_user_agent_retain_until', sparse: true },
    ),
    ...identityKeys.map(key =>
      events.createIndex(
        { siteKey: 1, [`identity.${key}`]: 1 },
        {
          name: `site_identity_${key}`,
          partialFilterExpression: { [`identity.${key}`]: { $exists: true } },
        },
      ),
    ),
    consents.createIndex({ siteKey: 1, consentId: 1 }, { name: 'site_consent' }),
    consents.createIndex({ profile: 1, recordedAt: 1 }, { name: 'profile_recorded' }),
    consents.createIndex({ _order: 1 }, { name: 'order' }),
    consents.createIndex({ retainUntil: 1 }, { name: 'retain_until', ...ttl }),
    ...identityKeys.map(key =>
      consents.createIndex(
        { siteKey: 1, [`identity.${key}`]: 1 },
        {
          name: `site_identity_${key}`,
          partialFilterExpression: { [`identity.${key}`]: { $exists: true } },
        },
      ),
    ),
    ...identityKeys.map(key =>
      identities.createIndex(
        { siteKey: 1, [`identity.${key}`]: 1 },
        { name: `site_identity_${key}` },
      ),
    ),
    identities.createIndex({ _order: 1 }, { name: 'order' }),
  ])
  return created
}

// --- sites -------------------------------------------------------------------------------------

export interface MongoSitesOptions {
  db: MongoDbSource
  /** Default analytics_sites. Documents are site definitions (siteKey, allowedOrigins, ...). */
  collection?: string
  logger?: Logger
}

/**
 * Sites from a MongoDB collection, managed by your own admin tools. Wrap it in cachedSites()
 * to avoid a query per request. An invalid document is logged and treated as unknown.
 */
export function mongoSites(
  options: MongoSitesOptions,
): Required<SiteSource> & { ensureIndexes(): Promise<void> } {
  const name = options.collection ?? 'analytics_sites'
  const logger = options.logger ?? consoleLogger()
  const collection = () => resolveDb(options.db).collection(name)
  return {
    async getSite(siteKey): Promise<Site | null> {
      const doc = await collection().findOne({ siteKey })
      if (!doc) return null
      const input: Doc = { ...doc }
      delete input._id
      try {
        return defineSite(input as Parameters<typeof defineSite>[0], `${name}[${siteKey}]`)
      } catch (error) {
        if (!(error instanceof SiteConfigError)) throw error
        logger.error(
          { ...errorFields(error), siteKey },
          'invalid site document; treated as unknown',
        )
        return null
      }
    },
    async isOriginAllowed(origin) {
      return (
        (await collection().findOne({ allowedOrigins: origin }, { projection: { _id: 1 } })) !==
        null
      )
    },
    async isCredentialedOrigin(origin) {
      return (
        (await collection().findOne(
          { allowedOrigins: origin, credentials: true },
          { projection: { _id: 1 } },
        )) !== null
      )
    },
    async ensureIndexes() {
      await Promise.all([
        collection().createIndex({ siteKey: 1 }, { name: 'site_key', unique: true }),
        collection().createIndex({ allowedOrigins: 1 }, { name: 'allowed_origins' }),
      ])
    },
  }
}
