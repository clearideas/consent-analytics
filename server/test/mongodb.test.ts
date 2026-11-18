// The MongoDB store and site source against a real MongoDB (see test/support/services.ts).
import { MongoClient } from 'mongodb'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'

import { toFetchHandler } from '../src/http/fetch.ts'
import {
  cachedSites,
  chainSites,
  createCollector,
  fixedGeo,
  memoryQueue,
  runWorker,
  silentLogger,
  startRetention,
  strictDataPolicy,
} from '../src/index.ts'
import { ensureMongoIndexes, mongoSites, mongoStore } from '../src/stores/mongodb.ts'
import { runStoreConformance, storedConsent, storedEvent } from './support/store-conformance.ts'

const url = inject('mongodbUrl')
const fastTtl = inject('mongodbFastTtl')
let client: MongoClient
let databases = 0
const freshDb = () => client.db(`ca_test_${process.pid}_${++databases}`)

describe.skipIf(!url)('MongoDB', () => {
  beforeAll(async () => {
    client = new MongoClient(url)
    await client.connect()
  })
  afterAll(async () => {
    const { databases: all } = await client.db().admin().listDatabases()
    await Promise.all(
      all
        .filter(d => d.name.startsWith(`ca_test_${process.pid}_`))
        .map(d => client.db(d.name).dropDatabase()),
    )
    await client.close()
  })

  runStoreConformance('mongoStore', async () => {
    const db = freshDb()
    const store = mongoStore({ db })
    await ensureMongoIndexes(store)
    return { store, reader: store, cleanup: async () => void (await db.dropDatabase()) }
  })

  describe('mongoStore specifics', () => {
    it('creates its indexes idempotently, with TTL on retainUntil', async () => {
      const db = freshDb()
      const store = mongoStore({
        db,
        collections: { events: 'ev', consents: 'co', identities: 'id' },
      })
      await ensureMongoIndexes(store, { identityKeys: ['tenantId'] })
      await ensureMongoIndexes(store, { identityKeys: ['tenantId'] }) // again: no error
      const events = await db.collection('ev').indexes()
      expect(events.map(i => i.name).sort()).toEqual(
        [
          '_id_',
          'ip_retain_until',
          'order',
          'profile_received',
          'raw_user_agent_retain_until',
          'retain_until',
          'site_identity_tenantId',
          'site_name_received',
          'site_received',
          'site_session',
        ].sort(),
      )
      expect(events.find(i => i.name === 'retain_until')).toMatchObject({ expireAfterSeconds: 0 })
      expect(
        (await db.collection('co').indexes()).find(i => i.name === 'retain_until'),
      ).toMatchObject({
        expireAfterSeconds: 0,
      })
    })

    it('stores server times and retention dates as BSON dates, client times as received', async () => {
      const db = freshDb()
      const store = mongoStore({ db })
      await store.insertEvents([storedEvent()])
      const doc = await db
        .collection('analytics_events')
        .findOne({ _id: 'site-a:event-00000001' as any })
      expect(doc!.receivedAt).toBeInstanceOf(Date)
      expect(doc!.retainUntil).toBeInstanceOf(Date)
      expect(doc!.ipRetainUntil).toBeInstanceOf(Date)
      expect(doc!.occurredAt).toBe('2026-11-10T12:00:00.000Z')
    })

    it('keeps awkward prop keys (dots, $-prefixed) and values intact', async () => {
      const store = mongoStore({ db: freshDb() })
      const props = {
        'a.b': 1,
        $where: 'x',
        nested: { $gt: 1, 'c.d': [1, { $e: true }] },
        '': 'empty key',
      }
      await store.insertEvents([storedEvent({ props })])
      expect((await store.listEvents())[0]!.props).toEqual(props)
    })

    it.skipIf(!fastTtl)(
      'MongoDB deletes expired events and consent records itself (TTL index)',
      async () => {
        const db = freshDb()
        const store = mongoStore({ db })
        await ensureMongoIndexes(store)
        const soon = new Date(Date.now() + 500).toISOString()
        await store.insertEvents([
          storedEvent({ retainUntil: soon }),
          storedEvent({ eventId: 'event-keep-01', retainUntil: '2099-01-01T00:00:00.000Z' }),
        ])
        await store.insertConsent(storedConsent({ retainUntil: soon }))
        await vi.waitFor(
          async () => {
            expect((await store.listEvents()).map(e => e.eventId)).toEqual(['event-keep-01'])
            expect(await store.listConsents()).toEqual([])
          },
          { timeout: 20_000, interval: 500 },
        )
      },
    )

    it('a database that is not connected yet is a store failure (the collector answers 503)', async () => {
      let connected: ReturnType<typeof freshDb> | undefined
      const store = mongoStore({ db: () => connected })
      await expect(store.insertEvents([storedEvent()])).rejects.toThrow(
        'MongoDB is not connected yet',
      )
      connected = freshDb()
      expect(await store.insertEvents([storedEvent()])).toEqual({ inserted: 1, duplicates: 0 })
    })

    it('works with Mongoose (mongoose.connection.db, connected lazily)', async () => {
      const connection = mongoose.createConnection(url, {
        dbName: `ca_test_${process.pid}_mongoose`,
      })
      try {
        const store = mongoStore({ db: () => connection.db })
        await connection.asPromise()
        await ensureMongoIndexes(store)
        expect(await store.insertEvents([storedEvent(), storedEvent()])).toEqual({
          inserted: 1,
          duplicates: 1,
        })
        await store.health!()
        expect(await store.listEvents()).toHaveLength(1)
      } finally {
        await connection.dropDatabase()
        await connection.close()
      }
    })

    it('retention job: purges with the current data policy', async () => {
      const db = freshDb()
      const store = mongoStore({ db })
      const policy = strictDataPolicy()
      policy.profiles['no-consent']!.retention = { events: '30d' }
      await store.insertEvents([
        storedEvent({
          eventId: 'event-old-001',
          profile: 'no-consent',
          receivedAt: '2026-01-01T00:00:00.000Z',
          retainUntil: '2099-01-01T00:00:00.000Z',
        }),
        storedEvent({
          eventId: 'event-new-001',
          profile: 'no-consent',
          receivedAt: '2026-11-09T00:00:00.000Z',
          retainUntil: '2099-01-01T00:00:00.000Z',
        }),
      ])
      const results: unknown[] = []
      const retention = startRetention({
        store,
        dataPolicy: policy,
        logger: false,
        clock: () => new Date('2026-11-10T00:00:00.000Z'),
        onResult: result => results.push(result),
      })
      await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 10_000 })
      await retention.stop()
      expect((await store.listEvents()).map(e => e.eventId)).toEqual(['event-new-001'])
    })
  })

  describe('mongoSites', () => {
    it('reads site definitions; invalid documents are treated as unknown; cached and chained', async () => {
      const db = freshDb()
      const error = vi.fn()
      const source = mongoSites({ db, logger: { ...silentLogger, error } })
      await source.ensureIndexes()
      await db.collection('analytics_sites').insertMany([
        {
          siteKey: 'db-site',
          allowedOrigins: ['https://db.example'],
          policyVersion: 3,
          credentials: true,
        },
        { siteKey: 'broken-site', allowedOrigins: ['not a url'] },
      ])
      expect(await source.getSite('db-site')).toEqual({
        siteKey: 'db-site',
        allowedOrigins: ['https://db.example'],
        policyVersion: '3',
        consentMode: 'geo',
        trackingWithoutConsent: 'limited',
        credentials: true,
      })
      expect(await source.getSite('broken-site')).toBeNull()
      expect(error).toHaveBeenCalledOnce()
      expect(await source.getSite('nope')).toBeNull()
      expect(await source.isOriginAllowed('https://db.example')).toBe(true)
      expect(await source.isOriginAllowed('https://evil.example')).toBe(false)
      expect(await source.isCredentialedOrigin('https://db.example')).toBe(true)

      const cached = cachedSites(
        chainSites({ getSite: () => null, isOriginAllowed: () => false }, source),
        { ttlMs: 60_000 },
      )
      expect((await cached.getSite('db-site'))!.policyVersion).toBe('3')
      await db
        .collection('analytics_sites')
        .updateOne({ siteKey: 'db-site' }, { $set: { policyVersion: '4' } })
      expect((await cached.getSite('db-site'))!.policyVersion).toBe('3') // cached
      cached.invalidate('db-site')
      expect((await cached.getSite('db-site'))!.policyVersion).toBe('4')
    })
  })

  describe('a collector on MongoDB, end to end', () => {
    const event = (id: number, identity = false) => ({
      eventId: `event-${String(id).padStart(10, '0')}`,
      name: 'page_view',
      occurredAt: '2026-11-10T12:00:00.000Z',
      sessionId: 'session-0000001',
      trackingCategory: 'full',
      consent: { required: false, granted: false },
      props: { path: '/pricing', ...(identity ? {} : {}) },
    })

    it('direct and queued delivery store the same documents; identity and traits included', async () => {
      const run = async (mode: 'direct' | 'queued') => {
        const db = freshDb()
        const store = mongoStore({ db })
        await ensureMongoIndexes(store)
        const queue = memoryQueue()
        const delivery =
          mode === 'direct'
            ? undefined
            : {
                events: { mode: 'queued' as const, queue },
                consent: { mode: 'queued' as const, queue },
              }
        const collector = createCollector({
          sites: mongoSites({ db: () => db }),
          store: mode === 'direct' ? store : undefined,
          delivery,
          geo: fixedGeo({ country: 'US' }),
          identify: () => ({ userId: 'u-1', plan: 'pro' }),
          identity: { traits: ['plan'] },
          clock: () => new Date('2026-11-10T12:00:05.000Z'),
          logger: false,
        })
        await db.collection('analytics_sites').insertOne({
          siteKey: 'my-site',
          allowedOrigins: ['https://www.example.com'],
          credentials: true,
        })
        const handle = toFetchHandler(collector)
        const post = (path: string, body: unknown) =>
          handle(
            new Request(`http://collector.test${path}`, {
              method: 'POST',
              headers: { Origin: 'https://www.example.com', 'Content-Type': 'text/plain' },
              body: JSON.stringify(body),
            }),
          )
        const batch = {
          v: 1,
          siteKey: 'my-site',
          sentAt: '2026-11-10T12:00:01.000Z',
          events: [event(1), event(2), event(1)],
        }
        expect((await post('/v1/events', batch)).status).toBe(202)
        expect(
          (
            await post('/v1/consent', {
              v: 1,
              siteKey: 'my-site',
              consentId: 'consent-0000001',
              decision: 'granted',
              policyVersion: '1',
              decidedAt: '2026-11-10T12:00:00.000Z',
              source: 'banner',
            })
          ).status,
        ).toBe(201)
        if (mode === 'queued') {
          const worker = runWorker({ queue, store, waitMs: 20, logger: false })
          await vi.waitFor(() => expect(queue.size()).toBe(0), { timeout: 10_000 })
          await worker.stop()
        }
        return {
          events: await store.listEvents(),
          consents: await store.listConsents(),
          identities: (await store.listIdentities()).map(
            ({ seenAt: _seenAt, ...rest }: any) => rest,
          ),
        }
      }
      const direct = await run('direct')
      expect(direct.events).toHaveLength(2)
      expect(direct.events[0]).toMatchObject({
        identity: { userId: 'u-1' },
        profile: 'open',
        server: { geo: { country: 'US' } },
      })
      expect(direct.consents[0]).toMatchObject({
        identity: { userId: 'u-1' },
        retainUntil: '2031-11-10T12:00:05.000Z',
      })
      expect(direct.identities).toEqual([
        expect.objectContaining({ identity: { userId: 'u-1' }, traits: { plan: 'pro' } }),
      ])
      expect(await run('queued')).toEqual(direct)
    })
  })
})
