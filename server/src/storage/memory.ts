// In-memory store: tests, development and throwaway demos. Data is lost on restart.
import { due, identityMatches, profileCutoffs, siteMatches } from './subject.ts'
import type {
  CollectorReader,
  CollectorStore,
  InsertConsentResult,
  InsertEventsResult,
  ListOptions,
  StoredConsent,
  StoredEvent,
  StoredIdentity,
} from './types.ts'
import { assertSubjectSelector } from './types.ts'

export interface MemoryStore
  extends
    Required<Omit<CollectorStore, 'health' | 'close'>>,
    Pick<CollectorStore, 'health' | 'close'>,
    CollectorReader {
  upsertIdentity(record: StoredIdentity): Promise<void>
  listIdentities(options?: ListOptions): Promise<Array<StoredIdentity & { firstSeenAt: string }>>
  /** Remove everything. */
  clear(): void
}

export function memoryStore(): MemoryStore {
  const events: StoredEvent[] = []
  const consents: StoredConsent[] = []
  const eventKeys = new Set<string>()
  const consentById = new Map<string, StoredConsent>()
  const identities = new Map<string, StoredIdentity & { firstSeenAt: string }>()
  const identityKey = (record: { siteKey: string; identity: StoredIdentity['identity'] }) =>
    JSON.stringify([
      record.siteKey,
      Object.entries(record.identity).sort(([a], [b]) => (a < b ? -1 : 1)),
    ])

  const list = <T extends { siteKey: string }>(items: T[], options: ListOptions = {}) =>
    items
      .filter(item => !options.siteKey || item.siteKey === options.siteKey)
      .slice(0, options.limit ?? 500)
      .map(item => structuredClone(item))

  return {
    async insertEvents(batch): Promise<InsertEventsResult> {
      let inserted = 0
      let duplicates = 0
      for (const event of batch) {
        const key = `${event.siteKey}\u0000${event.eventId}`
        if (eventKeys.has(key)) {
          duplicates++
          continue
        }
        eventKeys.add(key)
        events.push(structuredClone(event))
        inserted++
      }
      return { inserted, duplicates }
    },

    async insertConsent(record): Promise<InsertConsentResult> {
      const existing = consentById.get(record.recordId)
      if (existing) return { duplicate: true, recordedAt: existing.recordedAt }
      const copy = structuredClone(record)
      consentById.set(record.recordId, copy)
      consents.push(copy)
      return { duplicate: false, recordedAt: record.recordedAt }
    },

    async upsertIdentity(record) {
      const key = identityKey(record)
      const existing = identities.get(key)
      identities.set(key, {
        ...structuredClone(record),
        traits: { ...existing?.traits, ...record.traits },
        firstSeenAt: existing?.firstSeenAt ?? record.seenAt,
      })
    },

    async purge(options) {
      const result = {
        eventsDeleted: 0,
        ipsRemoved: 0,
        rawUserAgentsRemoved: 0,
        consentsDeleted: 0,
      }
      const cutoffs = profileCutoffs(options)
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]!
        const cutoff = cutoffs.get(event.profile)
        if (
          due(event.retainUntil, options.now) ||
          due(event.receivedAt, cutoff?.eventsBefore, false)
        ) {
          events.splice(i, 1)
          eventKeys.delete(`${event.siteKey}\u0000${event.eventId}`)
          result.eventsDeleted++
          continue
        }
        if (
          event.server?.ip &&
          (due(event.ipRetainUntil, options.now) || due(event.receivedAt, cutoff?.ipBefore, false))
        ) {
          delete event.server.ip
          delete event.server.ipForm
          delete event.ipRetainUntil
          result.ipsRemoved++
        }
        if (
          event.server?.userAgent?.raw &&
          (due(event.rawUserAgentRetainUntil, options.now) ||
            due(event.receivedAt, cutoff?.rawUserAgentBefore, false))
        ) {
          delete event.server.userAgent.raw
          delete event.rawUserAgentRetainUntil
          result.rawUserAgentsRemoved++
        }
      }
      for (let i = consents.length - 1; i >= 0; i--) {
        const record = consents[i]!
        if (
          due(record.retainUntil, options.now) ||
          due(record.recordedAt, cutoffs.get(record.profile)?.consentsBefore, false)
        ) {
          consents.splice(i, 1)
          consentById.delete(record.recordId)
          result.consentsDeleted++
        }
      }
      return result
    },

    async exportSubject(selector) {
      assertSubjectSelector(selector)
      return {
        events: events
          .filter(e => siteMatches(e.siteKey, selector))
          .filter(
            e =>
              identityMatches(e.identity, selector.identity) ||
              (!!selector.sessionId && e.sessionId === selector.sessionId),
          )
          .map(e => structuredClone(e)),
        consents: consents
          .filter(c => siteMatches(c.siteKey, selector))
          .filter(
            c =>
              identityMatches(c.identity, selector.identity) ||
              (!!selector.consentId && c.consentId === selector.consentId),
          )
          .map(c => structuredClone(c)),
        identities: [...identities.values()]
          .filter(
            i => siteMatches(i.siteKey, selector) && identityMatches(i.identity, selector.identity),
          )
          .map(record => structuredClone(record)),
      }
    },

    async eraseSubject(selector) {
      assertSubjectSelector(selector)
      const result = { eventsDeleted: 0, consentsDeidentified: 0, identitiesDeleted: 0 }
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]!
        if (
          siteMatches(e.siteKey, selector) &&
          (identityMatches(e.identity, selector.identity) ||
            (!!selector.sessionId && e.sessionId === selector.sessionId))
        ) {
          events.splice(i, 1)
          eventKeys.delete(`${e.siteKey}\u0000${e.eventId}`)
          result.eventsDeleted++
        }
      }
      for (const c of consents) {
        if (
          c.identity &&
          siteMatches(c.siteKey, selector) &&
          (identityMatches(c.identity, selector.identity) ||
            (!!selector.consentId && c.consentId === selector.consentId))
        ) {
          delete c.identity
          result.consentsDeidentified++
        }
      }
      for (const [key, record] of identities) {
        if (
          siteMatches(record.siteKey, selector) &&
          identityMatches(record.identity, selector.identity)
        ) {
          identities.delete(key)
          result.identitiesDeleted++
        }
      }
      return result
    },

    async health() {},
    async close() {},

    async listEvents(options) {
      return list(events, options)
    },
    async listConsents(options) {
      return list(consents, options)
    },
    async listIdentities(options) {
      return list([...identities.values()], options)
    },

    clear() {
      events.length = 0
      consents.length = 0
      eventKeys.clear()
      consentById.clear()
      identities.clear()
    },
  }
}
