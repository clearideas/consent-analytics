// Conformance tests every CollectorStore must pass (memory now; MongoDB, Postgres, ... later).
// The collector relies on exactly these behaviors.
import { describe, expect, it } from 'vitest'

import type {
  CollectorReader,
  CollectorStore,
  StoredConsent,
  StoredEvent,
} from '../../src/index.ts'

export interface StoreUnderTest {
  store: CollectorStore
  /** Read back what was stored (insertion order). */
  reader: CollectorReader
  cleanup?(): Promise<void>
}

export const storedEvent = (overrides: Partial<StoredEvent> = {}): StoredEvent => ({
  siteKey: 'site-a',
  eventId: 'event-00000001',
  name: 'page_view',
  occurredAt: '2026-11-10T12:00:00.000Z',
  occurredAtCorrected: '2026-11-10T12:00:01.000Z',
  sentAt: '2026-11-10T12:00:01.000Z',
  receivedAt: '2026-11-10T12:00:02.000Z',
  sessionId: 'session-0000001',
  pageViewId: null,
  trackingCategory: 'full',
  consent: { required: false, granted: false },
  props: { path: '/', nested: { a: [1, 2, null], b: true }, unicode: 'Zürich 😀' },
  page: { path: '/', title: 'Home' },
  attribution: { utm_source: 'news' },
  engagement: { clicks: 0, timeSpent: 12 },
  origin: 'https://www.example.com',
  profile: 'open',
  server: {
    ip: '203.0.113.9',
    ipForm: 'full',
    geo: { country: 'US', regionCode: 'US-CA', latitude: 37.77, longitude: -122.42 },
    userAgent: { browser: 'Firefox', device: 'desktop', isBot: false, raw: 'Mozilla/5.0' },
    gpc: false,
  },
  sanitized: ['occurred-at-replaced'],
  retainUntil: '2029-11-10T12:00:02.000Z',
  ipRetainUntil: '2027-05-09T12:00:02.000Z',
  ...overrides,
})

export const storedConsent = (overrides: Partial<StoredConsent> = {}): StoredConsent => ({
  recordId: 'record-1',
  siteKey: 'site-a',
  consentId: 'consent-0000001',
  decision: 'granted',
  categories: { preferences: true, statistics: true, marketing: true },
  policyVersion: '1',
  decidedAt: '2026-11-10T12:00:00.000Z',
  recordedAt: '2026-11-10T12:00:01.000Z',
  source: 'banner',
  origin: 'https://www.example.com',
  profile: 'gdpr',
  annotations: [],
  retainUntil: '2031-11-10T12:00:01.000Z',
  ...overrides,
})

export function runStoreConformance(name: string, create: () => Promise<StoreUnderTest>) {
  describe(`${name}: store conformance`, () => {
    const withStore = (test: (subject: StoreUnderTest) => Promise<void>) => async () => {
      const subject = await create()
      try {
        await test(subject)
      } finally {
        await subject.cleanup?.()
      }
    }

    it(
      'round-trips events exactly, in insertion order, filtered by site and limited',
      withStore(async ({ store, reader }) => {
        const a = storedEvent()
        const b = storedEvent({
          eventId: 'event-00000002',
          siteKey: 'site-b',
          pageViewId: 'pv-0000001',
        })
        // A limited event with none of the optional fields.
        const full = storedEvent({ eventId: 'event-00000003' })
        const c: StoredEvent = {
          siteKey: full.siteKey,
          eventId: full.eventId,
          name: full.name,
          occurredAt: full.occurredAt,
          occurredAtCorrected: full.occurredAtCorrected,
          sentAt: full.sentAt,
          receivedAt: full.receivedAt,
          sessionId: full.sessionId,
          pageViewId: null,
          trackingCategory: 'limited',
          consent: { required: true, granted: false },
          props: { path: '/' },
          origin: full.origin,
          profile: 'gdpr',
        }
        expect(await store.insertEvents([a, b])).toEqual({ inserted: 2, duplicates: 0 })
        expect(await store.insertEvents([c])).toEqual({ inserted: 1, duplicates: 0 })

        expect(await reader.listEvents()).toEqual([a, b, c])
        expect(await reader.listEvents({ siteKey: 'site-b' })).toEqual([b])
        expect(await reader.listEvents({ limit: 1 })).toEqual([a])
      }),
    )

    it(
      'stores each (siteKey, eventId) once: across batches and within one batch',
      withStore(async ({ store, reader }) => {
        expect(await store.insertEvents([storedEvent()])).toEqual({ inserted: 1, duplicates: 0 })
        expect(
          await store.insertEvents([
            storedEvent({ name: 'changed' }), // duplicate of the stored one: not overwritten
            storedEvent({ eventId: 'event-00000002' }),
            storedEvent({ eventId: 'event-00000002' }), // duplicate within the batch
            storedEvent({ siteKey: 'site-b' }), // same eventId, other site: distinct
          ]),
        ).toEqual({ inserted: 2, duplicates: 2 })
        expect((await reader.listEvents()).map(e => [e.siteKey, e.eventId, e.name])).toEqual([
          ['site-a', 'event-00000001', 'page_view'],
          ['site-a', 'event-00000002', 'page_view'],
          ['site-b', 'event-00000001', 'page_view'],
        ])
      }),
    )

    it(
      'an empty batch is a no-op',
      withStore(async ({ store, reader }) => {
        expect(await store.insertEvents([])).toEqual({ inserted: 0, duplicates: 0 })
        expect(await reader.listEvents()).toEqual([])
      }),
    )

    it(
      'appends consent records; a repeated recordId is a duplicate with the original recordedAt',
      withStore(async ({ store, reader }) => {
        const first = storedConsent()
        const withdrawal = storedConsent({
          recordId: 'record-2',
          decision: 'denied',
          categories: { preferences: false, statistics: false, marketing: false },
        })
        const legacy = storedConsent({
          recordId: 'record-3',
          categories: null,
          annotations: ['policy-version-not-current'],
        })
        delete legacy.retainUntil
        expect(await store.insertConsent(first)).toEqual({
          duplicate: false,
          recordedAt: first.recordedAt,
        })
        expect(await store.insertConsent(withdrawal)).toEqual({
          duplicate: false,
          recordedAt: withdrawal.recordedAt,
        })
        expect(await store.insertConsent(legacy)).toEqual({
          duplicate: false,
          recordedAt: legacy.recordedAt,
        })
        expect(
          await store.insertConsent(storedConsent({ recordedAt: '2026-11-11T00:00:00.000Z' })),
        ).toEqual({ duplicate: true, recordedAt: first.recordedAt })

        expect(await reader.listConsents()).toEqual([first, withdrawal, legacy])
        expect(await reader.listConsents({ siteKey: 'site-b' })).toEqual([])
      }),
    )

    it(
      'keeps its own copies of what it stores and returns',
      withStore(async ({ store, reader }) => {
        const event = storedEvent()
        await store.insertEvents([event])
        ;(event.props as any).path = '/mutated-after-insert'
        const [read] = await reader.listEvents()
        expect(read!.props.path).toBe('/')
        ;(read!.props as any).path = '/mutated-after-read'
        expect((await reader.listEvents())[0]!.props.path).toBe('/')
      }),
    )

    it(
      'handles concurrent inserts of the same events without duplicates',
      withStore(async ({ store, reader }) => {
        const events = Array.from({ length: 20 }, (_, i) =>
          storedEvent({ eventId: `event-${String(i).padStart(8, '0')}` }),
        )
        const results = await Promise.all(
          Array.from({ length: 5 }, () => store.insertEvents(events)),
        )
        expect(results.reduce((sum, r) => sum + r.inserted, 0)).toBe(20)
        expect(results.reduce((sum, r) => sum + r.duplicates, 0)).toBe(80)
        expect(await reader.listEvents({ limit: 1000 })).toHaveLength(20)
      }),
    )

    it(
      'upsertIdentity (if implemented): one record per identity, latest traits win',
      withStore(async ({ store, reader }) => {
        if (!store.upsertIdentity || !reader.listIdentities) return
        const identity = { userId: 'u-1', accountId: 'acct-9' }
        await store.upsertIdentity({
          siteKey: 'site-a',
          identity,
          traits: { plan: 'free', seats: 1 },
          seenAt: '2026-11-10T12:00:00.000Z',
        })
        await store.upsertIdentity({
          siteKey: 'site-a',
          identity: { accountId: 'acct-9', userId: 'u-1' }, // same identity, other key order
          traits: { plan: 'pro' },
          seenAt: '2026-11-11T12:00:00.000Z',
        })
        await store.upsertIdentity({
          siteKey: 'site-b',
          identity,
          traits: { plan: 'free' },
          seenAt: '2026-11-10T12:00:00.000Z',
        })
        const records = await reader.listIdentities({ siteKey: 'site-a' })
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({
          identity,
          traits: { plan: 'pro', seats: 1 },
          seenAt: '2026-11-11T12:00:00.000Z',
        })
        expect(await reader.listIdentities()).toHaveLength(2)
      }),
    )

    it(
      'purge (if implemented): own expiry dates, expired fields, and per-profile cutoffs',
      withStore(async ({ store, reader }) => {
        if (!store.purge) return
        const now = new Date('2027-01-01T00:00:00.000Z')
        const past = '2026-12-31T00:00:00.000Z'
        const future = '2027-06-01T00:00:00.000Z'
        await store.insertEvents([
          storedEvent({ eventId: 'expired-0001', retainUntil: past }),
          storedEvent({ eventId: 'ip-expired-1', retainUntil: future, ipRetainUntil: past }),
          storedEvent({
            eventId: 'ua-expired-1',
            retainUntil: future,
            ipRetainUntil: future,
            rawUserAgentRetainUntil: past,
          }),
          // Profile cutoff: received before the current policy's limit, though its own date is later.
          storedEvent({
            eventId: 'old-profile1',
            profile: 'gdpr',
            receivedAt: '2024-01-01T00:00:00.000Z',
            retainUntil: future,
          }),
          storedEvent({ eventId: 'keep-000001', retainUntil: future, ipRetainUntil: future }),
        ])
        await store.insertConsent(storedConsent({ recordId: 'expired', retainUntil: past }))
        await store.insertConsent(
          storedConsent({
            recordId: 'old-profile',
            profile: 'gdpr',
            recordedAt: '2020-01-01T00:00:00.000Z',
            retainUntil: future,
          }),
        )
        await store.insertConsent(storedConsent({ recordId: 'kept', retainUntil: future }))

        const result = await store.purge({
          now,
          profiles: [
            {
              profile: 'gdpr',
              eventsBefore: new Date('2025-01-01T00:00:00.000Z'),
              consentsBefore: new Date('2022-01-01T00:00:00.000Z'),
            },
          ],
        })
        expect(result).toEqual({
          eventsDeleted: 2,
          ipsRemoved: 1,
          rawUserAgentsRemoved: 1,
          consentsDeleted: 2,
        })

        const remaining = new Map((await reader.listEvents()).map(e => [e.eventId, e]))
        expect([...remaining.keys()].sort()).toEqual([
          'ip-expired-1',
          'keep-000001',
          'ua-expired-1',
        ])
        expect(remaining.get('ip-expired-1')!.server).not.toHaveProperty('ip')
        expect(remaining.get('ip-expired-1')!.server).not.toHaveProperty('ipForm')
        expect(remaining.get('ip-expired-1')).not.toHaveProperty('ipRetainUntil')
        expect(remaining.get('ip-expired-1')!.server!.userAgent!.raw).toBe('Mozilla/5.0') // not due yet
        expect(remaining.get('ua-expired-1')!.server!.userAgent).not.toHaveProperty('raw')
        expect(remaining.get('ua-expired-1')!.server!.ip).toBe('203.0.113.9')
        expect(remaining.get('keep-000001')).toEqual(
          storedEvent({ eventId: 'keep-000001', retainUntil: future, ipRetainUntil: future }),
        )
        expect((await reader.listConsents()).map(c => c.recordId)).toEqual(['kept'])
        // Nothing left to do: a second purge changes nothing.
        expect(await store.purge({ now })).toEqual({
          eventsDeleted: 0,
          ipsRemoved: 0,
          rawUserAgentsRemoved: 0,
          consentsDeleted: 0,
        })
      }),
    )

    it(
      'data subject requests (if implemented): export, then erase (consent records de-identified)',
      withStore(async ({ store }) => {
        if (!store.exportSubject || !store.eraseSubject) return
        const u1 = { userId: 'u-1', accountId: 'acct-1' }
        await store.insertEvents([
          storedEvent({ eventId: 'u1-event-01', identity: u1 }),
          storedEvent({ eventId: 'u1-event-02', identity: u1, sessionId: 'session-u1' }),
          storedEvent({ eventId: 'u2-event-01', identity: { userId: 'u-2' } }),
          storedEvent({ eventId: 'anon-session', sessionId: 'session-anon' }),
          storedEvent({ eventId: 'u1-other-site', siteKey: 'site-b', identity: u1 }),
        ])
        await store.insertConsent(storedConsent({ recordId: 'u1-consent', identity: u1 }))
        await store.insertConsent(
          storedConsent({ recordId: 'browser-consent', consentId: 'consent-browser' }),
        )
        await store.insertConsent(
          storedConsent({ recordId: 'u2-consent', identity: { userId: 'u-2' } }),
        )
        await store.upsertIdentity?.({
          siteKey: 'site-a',
          identity: u1,
          traits: { plan: 'pro' },
          seenAt: '2026-11-10T12:00:00.000Z',
        })
        await store.upsertIdentity?.({
          siteKey: 'site-a',
          identity: { userId: 'u-2' },
          traits: {},
          seenAt: '2026-11-10T12:00:00.000Z',
        })

        await expect(store.exportSubject({ siteKey: 'site-a' })).rejects.toThrow(
          /identity, consentId or sessionId/,
        )
        const everywhere = await store.exportSubject({ identity: { userId: 'u-1' } })
        expect(everywhere.events.map(e => e.eventId).sort()).toEqual([
          'u1-event-01',
          'u1-event-02',
          'u1-other-site',
        ])
        const exported = await store.exportSubject({
          siteKey: 'site-a',
          identity: { userId: 'u-1' },
          consentId: 'consent-browser',
        })
        expect(exported.events.map(e => e.eventId).sort()).toEqual(['u1-event-01', 'u1-event-02'])
        expect(exported.consents.map(c => c.recordId).sort()).toEqual([
          'browser-consent',
          'u1-consent',
        ])
        if (store.upsertIdentity)
          expect(exported.identities).toEqual([
            expect.objectContaining({ identity: u1, traits: { plan: 'pro' } }),
          ])
        expect(
          (await store.exportSubject({ sessionId: 'session-anon' })).events.map(e => e.eventId),
        ).toEqual(['anon-session'])

        expect(
          await store.eraseSubject({ siteKey: 'site-a', identity: { userId: 'u-1' } }),
        ).toEqual({
          eventsDeleted: 2,
          consentsDeidentified: 1,
          identitiesDeleted: store.upsertIdentity ? 1 : 0,
        })
        const after = await store.exportSubject({ siteKey: 'site-a', identity: { userId: 'u-1' } })
        expect(after).toEqual({ events: [], consents: [], identities: [] })
        // The consent record is kept as evidence, without the identity.
        const kept = (await store.exportSubject({ consentId: 'consent-0000001' })).consents.find(
          c => c.recordId === 'u1-consent',
        )
        expect(kept).toBeDefined()
        expect(kept).not.toHaveProperty('identity')
        // Other people and other sites are untouched.
        expect((await store.exportSubject({ identity: { userId: 'u-2' } })).events).toHaveLength(1)
        expect(
          (await store.exportSubject({ identity: { userId: 'u-1' } })).events.map(e => e.eventId),
        ).toEqual(['u1-other-site'])
        expect((await store.eraseSubject({ sessionId: 'session-anon' })).eventsDeleted).toBe(1)
      }),
    )

    it(
      'reports health',
      withStore(async ({ store }) => {
        await expect(store.health?.() ?? Promise.resolve()).resolves.toBeUndefined()
      }),
    )
  })
}
