// Delivery building blocks: the message envelope, the ingest processor, the background writer.
import { describe, expect, it, vi } from 'vitest'

import type { CollectorStore, IngestMessage, StoredEvent } from '../src/index.ts'
import {
  backgroundWriter,
  createIngestProcessor,
  decodeMessage,
  encodeMessage,
  memoryStore,
  MessageFormatError,
  silentLogger,
} from '../src/index.ts'
import { storedConsent, storedEvent } from './support/store-conformance.ts'

const eventsMessage = (events: StoredEvent[], extra: Partial<IngestMessage> = {}): IngestMessage =>
  ({
    kind: 'events',
    v: 1,
    requestId: 'req-1',
    siteKey: 'site-a',
    events,
    ...extra,
  }) as IngestMessage
const consentMessage = (recordId = 'record-1'): IngestMessage => ({
  kind: 'consent',
  v: 1,
  requestId: 'req-2',
  record: storedConsent({ recordId }),
})
const event = (id: number) => storedEvent({ eventId: `event-${String(id).padStart(8, '0')}` })

describe('message envelope', () => {
  it('round-trips events (with identity traits) and consent messages', () => {
    const events = eventsMessage([event(1)], {
      identity: {
        identity: { userId: 'u-1' },
        traits: { plan: 'pro' },
        seenAt: '2026-11-10T12:00:00.000Z',
      },
    } as Partial<IngestMessage>)
    expect(decodeMessage(encodeMessage(events))).toEqual(events)
    expect(decodeMessage(encodeMessage(consentMessage()))).toEqual(consentMessage())
  })

  it.each([
    ['not JSON', '{', 'not JSON'],
    ['not an object', '[1]', 'not an object'],
    [
      'another version',
      JSON.stringify({ kind: 'events', v: 2, requestId: 'r' }),
      'unsupported message version 2',
    ],
    [
      'unknown kind',
      JSON.stringify({ kind: 'other', v: 1, requestId: 'r' }),
      'unknown message kind other',
    ],
    [
      'malformed event',
      JSON.stringify({ kind: 'events', v: 1, requestId: 'r', siteKey: 'site-a', events: [{}] }),
      'malformed event',
    ],
    [
      'event of another site',
      encodeMessage(eventsMessage([storedEvent({ siteKey: 'site-b' })])),
      'event of another site',
    ],
    [
      'malformed identity',
      JSON.stringify({ ...eventsMessage([event(1)]), identity: { identity: 'u' } }),
      'malformed identity',
    ],
    [
      'malformed consent record',
      JSON.stringify({ kind: 'consent', v: 1, requestId: 'r', record: {} }),
      'malformed consent record',
    ],
  ])('rejects %s', (_name, body, message) => {
    expect(() => decodeMessage(body)).toThrow(MessageFormatError)
    expect(() => decodeMessage(body)).toThrow(message)
  })
})

describe('ingest processor', () => {
  /** A memory store whose inserts fail for chosen event IDs, or entirely. */
  function flakyStore(options: { failEventIds?: string[]; down?: boolean } = {}) {
    const store = memoryStore()
    const insertEvents = store.insertEvents
    const calls: number[] = []
    store.insertEvents = async events => {
      calls.push(events.length)
      if (options.down || events.some(e => options.failEventIds?.includes(e.eventId)))
        throw new Error('write failed')
      return insertEvents(events)
    }
    const insertConsent = store.insertConsent
    store.insertConsent = async record => {
      if (options.down) throw new Error('write failed')
      return insertConsent(record)
    }
    return { store, calls }
  }

  it('writes the events of all messages in one bulk insert, with counts for a single message', async () => {
    const { store, calls } = flakyStore()
    const processor = createIngestProcessor({ store, logger: silentLogger })
    const outcomes = await processor.write([
      eventsMessage([event(1), event(2)]),
      eventsMessage([event(3)]),
      consentMessage(),
    ])
    expect(calls).toEqual([3])
    expect(outcomes).toEqual([
      { ok: true },
      { ok: true },
      { ok: true, consent: { duplicate: false, recordedAt: '2026-11-10T12:00:01.000Z' } },
    ])
    expect(await processor.write([eventsMessage([event(1), event(4)])])).toEqual([
      { ok: true, events: { inserted: 1, duplicates: 1 } },
    ])
  })

  it('isolates a failing message: the others are written', async () => {
    const { store } = flakyStore({ failEventIds: ['event-00000002'] })
    const processor = createIngestProcessor({ store, logger: silentLogger })
    const outcomes = await processor.write([
      eventsMessage([event(1)]),
      eventsMessage([event(2)]),
      eventsMessage([event(3)]),
    ])
    expect(outcomes.map(o => o.ok)).toEqual([true, false, true])
    expect(outcomes[1]).toMatchObject({ ok: false, permanent: false })
    expect((await store.listEvents()).map(e => e.eventId)).toEqual([
      'event-00000001',
      'event-00000003',
    ])
  })

  it('an outage fails every message (retryable)', async () => {
    const { store } = flakyStore({ down: true })
    const outcomes = await createIngestProcessor({ store, logger: silentLogger }).write([
      eventsMessage([event(1)]),
      consentMessage(),
    ])
    expect(outcomes.every(o => !o.ok && !o.permanent)).toBe(true)
  })

  it('identity traits after the events; a traits failure is reported, the message still succeeds', async () => {
    const { store } = flakyStore()
    const onError = vi.fn()
    const message = eventsMessage([event(1)], {
      identity: { identity: { userId: 'u-1' }, traits: { plan: 'pro' }, seenAt: 'now' },
    } as Partial<IngestMessage>)
    expect(
      await createIngestProcessor({ store, logger: silentLogger, onError }).write([message]),
    ).toEqual([{ ok: true, events: { inserted: 1, duplicates: 0 } }])
    expect((await store.listIdentities())[0]).toMatchObject({ traits: { plan: 'pro' } })

    store.upsertIdentity = async () => {
      throw new Error('identities down')
    }
    const [outcome] = await createIngestProcessor({ store, logger: silentLogger, onError }).write([
      message,
    ])
    expect(outcome!.ok).toBe(true)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      operation: 'store.upsertIdentity',
      requestId: 'req-1',
    })
  })

  it('process(): undecodable bodies fail permanently, the rest are written', async () => {
    const { store } = flakyStore()
    const outcomes = await createIngestProcessor({ store, logger: silentLogger }).process([
      encodeMessage(eventsMessage([event(1)])),
      'garbage',
      encodeMessage(consentMessage()),
    ])
    expect(outcomes.map(o => [o.ok, !o.ok && o.permanent])).toEqual([
      [true, false],
      [false, true],
      [true, false],
    ])
  })

  it('a store without upsertIdentity ignores traits', async () => {
    const store: CollectorStore = {
      insertEvents: async () => ({ inserted: 1, duplicates: 0 }),
      insertConsent: vi.fn(),
    }
    const message = eventsMessage([event(1)], {
      identity: { identity: { userId: 'u-1' }, traits: { plan: 'pro' }, seenAt: 'now' },
    } as Partial<IngestMessage>)
    expect(
      (await createIngestProcessor({ store, logger: silentLogger }).write([message]))[0]!.ok,
    ).toBe(true)
  })
})

describe('background writer', () => {
  const writer = (flush: (items: number[]) => Promise<number[]>, overrides = {}) =>
    backgroundWriter<number>({
      name: 'test',
      flush,
      maxBatch: 3,
      flushIntervalMs: 50,
      maxItems: 10,
      logger: silentLogger,
      retryBaseMs: 20,
      retryMaxMs: 80,
      ...overrides,
    })

  it('writes a full batch at once and the rest after the interval', async () => {
    const batches: number[][] = []
    const w = writer(async items => (batches.push(items), []))
    for (const item of [1, 2, 3, 4]) expect(w.offer(item)).toBe(true)
    await vi.waitFor(() => expect(batches).toEqual([[1, 2, 3], [4]]), { timeout: 10_000 })
    expect(w.stats()).toEqual({ buffered: 0, written: 4, failedFlushes: 0, lost: 0 })
  })

  it('refuses items when full', () => {
    const w = writer(() => new Promise(() => {}), { maxItems: 2 })
    expect([w.offer(1), w.offer(2), w.offer(3)]).toEqual([true, true, false])
  })

  it('retries failures with backoff, in order, until written', async () => {
    let attempts = 0
    const written: number[] = []
    const w = writer(async items => {
      attempts++
      if (attempts <= 2) throw new Error('down')
      if (attempts === 3) return (written.push(items[0]!), items.slice(1)) // partial
      written.push(...items)
      return []
    })
    for (const item of [1, 2, 3]) w.offer(item)
    await vi.waitFor(() => expect(written).toEqual([1, 2, 3]), { timeout: 10_000 })
    expect(w.stats()).toMatchObject({ written: 3, failedFlushes: 3, buffered: 0 })
  })

  it('close() writes what is left; past the deadline the rest is reported lost', async () => {
    const written: number[] = []
    const w = writer(async items => (written.push(...items), []), { flushIntervalMs: 60_000 })
    w.offer(1)
    w.offer(2)
    expect(await w.close(1_000)).toBe(0)
    expect(written).toEqual([1, 2])
    expect(w.offer(3)).toBe(false) // closed

    const error = vi.fn()
    const withLogger = backgroundWriter<number>({
      name: 'test',
      flush: async () => {
        throw new Error('down')
      },
      maxBatch: 3,
      flushIntervalMs: 50,
      maxItems: 10,
      logger: { ...silentLogger, error },
      retryBaseMs: 20,
    })
    withLogger.offer(7)
    expect(await withLogger.close(150)).toBe(1)
    expect(withLogger.stats().lost).toBe(1)
    expect(error).toHaveBeenCalledWith({ buffer: 'test', items: 1 }, expect.stringMatching(/lost/))
  })
})
