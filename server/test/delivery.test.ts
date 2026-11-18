// Delivery modes through a collector, and the queue worker.
import { describe, expect, it, vi } from 'vitest'

import { toFetchHandler } from '../src/http/fetch.ts'
import type {
  CollectorOptions,
  CollectorStore,
  DeliveryOptions,
  IngestQueue,
  MemoryStore,
} from '../src/index.ts'
import {
  createCollector,
  encodeMessage,
  fixedGeo,
  memoryQueue,
  memoryStore,
  runWorker,
} from '../src/index.ts'
import { expectMatchesSpec } from './support/spec.ts'
import { storedEvent } from './support/store-conformance.ts'

const ORIGIN = 'https://www.example.com'
const NOW = '2026-11-10T12:00:05.000Z'

let seq = 0
const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: `event-${String(++seq).padStart(10, '0')}`,
  name: 'page_view',
  occurredAt: '2026-11-10T12:00:00.000Z',
  sessionId: 'session-0000001',
  trackingCategory: 'full',
  consent: { required: false, granted: false },
  props: { path: '/pricing', title: 'Pricing' },
  ...overrides,
})
const batch = (...events: unknown[]) => ({
  v: 1,
  siteKey: 'my-site',
  sentAt: '2026-11-10T12:00:01.000Z',
  events,
})
const consent = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  siteKey: 'my-site',
  consentId: 'consent-0000001',
  decision: 'granted',
  policyVersion: '1',
  decidedAt: '2026-11-10T12:00:00.000Z',
  source: 'banner',
  ...overrides,
})

function setup(delivery: CollectorOptions['delivery'], overrides: Partial<CollectorOptions> = {}) {
  const store = memoryStore()
  const collector = createCollector({
    sites: [{ siteKey: 'my-site', allowedOrigins: [ORIGIN] }],
    store,
    delivery,
    geo: fixedGeo({ country: 'US' }),
    clock: () => new Date(NOW),
    logger: false,
    ...overrides,
  })
  const handle = toFetchHandler(collector)
  const post = async (path: string, body: unknown) => {
    const response = await handle(
      new Request(`http://collector.test${path}`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
        body: JSON.stringify(body),
      }),
    )
    const json: any = await response.json()
    expectMatchesSpec(path, 'POST', response.status, response.headers.get('content-type'), json)
    return { status: response.status, body: json, headers: response.headers }
  }
  return { store, collector, post }
}

/** Run a worker until the queue is empty, then stop it. */
async function work(queue: ReturnType<typeof memoryQueue>, store: CollectorStore) {
  const worker = runWorker({ queue, store, waitMs: 20, logger: false })
  await vi.waitFor(() => expect(queue.size()).toBe(0), { timeout: 10_000 })
  await worker.stop()
  return worker.stats()
}

describe('every delivery mode stores exactly the same data', () => {
  const traffic = async (post: ReturnType<typeof setup>['post']) => {
    const repeated = event()
    await post('/v1/events', batch(event(), repeated, event({ name: 'Not Valid' })))
    await post('/v1/events', batch(repeated, event({ name: 'sign_up', props: { plan: 'pro' } })))
    await post('/v1/consent', consent())
    await post('/v1/consent', consent()) // a retry
    await post(
      '/v1/consent',
      consent({ decision: 'denied', decidedAt: '2026-11-10T12:01:00.000Z' }),
    )
  }
  const snapshot = async (store: MemoryStore) => ({
    events: (await store.listEvents()).sort((a, b) => (a.eventId < b.eventId ? -1 : 1)),
    consents: (await store.listConsents()).sort((a, b) => (a.recordId < b.recordId ? -1 : 1)),
  })

  it('direct, buffered, queued (durable and fast) with a worker', async () => {
    const results = []
    for (const mode of ['direct', 'buffered', 'queued-durable', 'queued-fast'] as const) {
      seq = 0
      const queue = memoryQueue()
      const delivery: DeliveryOptions =
        mode === 'direct' || mode === 'buffered'
          ? { mode }
          : { mode: 'queued', queue, ack: mode === 'queued-fast' ? 'fast' : 'durable' }
      const { store, collector, post } = setup({ events: delivery, consent: delivery })
      await traffic(post)
      await collector.close() // flushes buffers (buffered, fast)
      if (mode.startsWith('queued')) await work(queue, store)
      results.push(await snapshot(store))
    }
    expect(results[0]!.events).toHaveLength(3)
    expect(results[0]!.consents).toHaveLength(2)
    for (const result of results.slice(1)) expect(result).toEqual(results[0])
  })
})

describe('responses by mode', () => {
  it('direct: real counts; asynchronous modes: accepted for storage, duplicates 0', async () => {
    const direct = setup(undefined)
    const e = event()
    await direct.post('/v1/events', batch(e))
    expect((await direct.post('/v1/events', batch(e, event()))).body).toEqual({
      accepted: 1,
      duplicates: 1,
      rejected: [],
    })

    const buffered = setup({ events: { mode: 'buffered' } })
    await buffered.post('/v1/events', batch(e))
    expect((await buffered.post('/v1/events', batch(e, event()))).body).toEqual({
      accepted: 2,
      duplicates: 0,
      rejected: [],
    })
    await buffered.collector.close()
    expect(await buffered.store.listEvents()).toHaveLength(2) // still stored once
  })

  it('a retried consent record gets the same recordId in every mode', async () => {
    const queue = memoryQueue()
    const queued = setup({ consent: { mode: 'queued', queue } })
    const first = await queued.post('/v1/consent', consent())
    const retry = await queued.post('/v1/consent', consent())
    expect(retry.body.recordId).toBe(first.body.recordId)
    await work(queue, queued.store)
    expect(await queued.store.listConsents()).toHaveLength(1)
  })
})

describe('buffered delivery', () => {
  it('answers before the store has written, and close() writes what is buffered', async () => {
    let release!: () => void
    const { store, collector, post } = setup({ events: { mode: 'buffered', flushIntervalMs: 10 } })
    const insertEvents = store.insertEvents
    store.insertEvents = async events => {
      await new Promise<void>(resolve => (release = resolve))
      return insertEvents(events)
    }
    expect((await post('/v1/events', batch(event()))).status).toBe(202)
    expect(await store.listEvents()).toEqual([])
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 10_000 })
    const closing = collector.close()
    release()
    await closing
    expect(await store.listEvents()).toHaveLength(1)
    expect(collector.stats().events).toMatchObject({
      mode: 'buffered',
      written: 1,
      buffered: 0,
      lost: 0,
    })
  })

  it('when full: write this request directly (default) or answer 503', async () => {
    const slow = (store: MemoryStore) => {
      const insertEvents = store.insertEvents
      store.insertEvents = async events => {
        await new Promise(resolve => setTimeout(resolve, 50))
        return insertEvents(events)
      }
    }
    const direct = setup({
      events: { mode: 'buffered', maxBufferedMessages: 1, flushIntervalMs: 10_000 },
    })
    slow(direct.store)
    await direct.post('/v1/events', batch(event())) // buffered
    const overflow = await direct.post('/v1/events', batch(event())) // written directly
    expect(overflow.body).toEqual({ accepted: 1, duplicates: 0, rejected: [] })
    expect(await direct.store.listEvents()).toHaveLength(1)
    await direct.collector.close()

    const reject = setup({
      events: {
        mode: 'buffered',
        maxBufferedMessages: 1,
        flushIntervalMs: 10_000,
        whenFull: 'reject',
      },
    })
    await reject.post('/v1/events', batch(event()))
    const refused = await reject.post('/v1/events', batch(event()))
    expect(refused.status).toBe(503)
    expect(refused.headers.get('Retry-After')).toBe('5')
    await reject.collector.close()
  })
})

describe('queued delivery', () => {
  const failingQueue = (): IngestQueue & { sent: string[][] } => {
    const sent: string[][] = []
    let failures = 1
    return {
      sent,
      async send(bodies) {
        if (failures-- > 0) throw new Error('queue down')
        sent.push([...bodies])
      },
      receive: async () => [],
      ack: async () => {},
      retry: async () => {},
      deadLetter: async () => {},
    }
  }

  it('durable: a queue failure is a 503 (clients retry)', async () => {
    const errors: string[] = []
    const queue = failingQueue()
    const { post } = setup(
      { events: { mode: 'queued', queue } },
      { hooks: { onError: (_e, { operation }) => errors.push(operation) } },
    )
    expect((await post('/v1/events', batch(event()))).status).toBe(503)
    expect(errors).toEqual(['queue.send'])
    expect((await post('/v1/events', batch(event()))).status).toBe(202)
    expect(queue.sent).toHaveLength(1)
  })

  it('fast: answers at once; a failing send is retried in the background', async () => {
    const queue = failingQueue()
    const { post, collector } = setup({
      events: { mode: 'queued', queue, ack: 'fast', flushIntervalMs: 10 },
    })
    expect((await post('/v1/events', batch(event()))).status).toBe(202)
    await vi.waitFor(() => expect(queue.sent).toHaveLength(1), { timeout: 10_000 })
    expect(collector.stats().events).toMatchObject({ mode: 'queued', failedFlushes: 1, written: 1 })
    await collector.close()
  })

  it('fast, when its buffer is full: send this request directly (default) or answer 503', async () => {
    const blocked: IngestQueue & { sent: number } = {
      sent: 0,
      async send() {
        blocked.sent++
      },
      receive: async () => [],
      ack: async () => {},
      retry: async () => {},
      deadLetter: async () => {},
    }
    const options = {
      mode: 'queued',
      queue: blocked,
      ack: 'fast',
      maxBufferedMessages: 1,
      flushIntervalMs: 60_000,
    } as const
    const durable = setup({ events: options })
    await durable.post('/v1/events', batch(event())) // buffered
    expect((await durable.post('/v1/events', batch(event()))).status).toBe(202) // sent directly
    expect(blocked.sent).toBe(1)
    await durable.collector.close()

    const reject = setup({ events: { ...options, whenFull: 'reject' } })
    await reject.post('/v1/events', batch(event()))
    expect((await reject.post('/v1/events', batch(event()))).status).toBe(503)
    await reject.collector.close()
  })

  it('the API needs no store when both endpoints are queued; otherwise it does', () => {
    const queue = memoryQueue()
    expect(() =>
      createCollector({
        sites: [{ siteKey: 'my-site', allowedOrigins: [ORIGIN] }],
        delivery: { events: { mode: 'queued', queue }, consent: { mode: 'queued', queue } },
        logger: false,
      }),
    ).not.toThrow()
    expect(() =>
      createCollector({
        sites: [{ siteKey: 'my-site', allowedOrigins: [ORIGIN] }],
        delivery: { events: { mode: 'queued', queue } },
        logger: false,
      }),
    ).toThrow('createCollector: delivery.consent: delivery mode "direct" needs a store')
    expect(() =>
      createCollector({
        sites: [{ siteKey: 'my-site', allowedOrigins: [ORIGIN] }],
        store: memoryStore(),
        delivery: { events: { mode: 'queued' } as any },
        logger: false,
      }),
    ).toThrow(/needs a queue/)
  })

  it('identity traits travel with the message and are stored by the worker', async () => {
    const queue = memoryQueue()
    const store = memoryStore()
    const collector = createCollector({
      sites: [{ siteKey: 'my-site', allowedOrigins: [ORIGIN], credentials: true }],
      delivery: { events: { mode: 'queued', queue }, consent: { mode: 'queued', queue } },
      identify: () => ({ userId: 'u-1', plan: 'pro' }),
      identity: { traits: ['plan'] },
      geo: fixedGeo({ country: 'US' }),
      logger: false,
    })
    await toFetchHandler(collector)(
      new Request('http://collector.test/v1/events', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
        body: JSON.stringify(batch(event())),
      }),
    )
    await work(queue, store)
    expect((await store.listEvents())[0]!.identity).toEqual({ userId: 'u-1' })
    expect((await store.listIdentities())[0]).toMatchObject({ traits: { plan: 'pro' } })
  })
})

describe('worker', () => {
  const message = (id: number) =>
    encodeMessage({
      kind: 'events',
      v: 1,
      requestId: `req-${id}`,
      siteKey: 'site-a',
      events: [storedEvent({ eventId: `event-${String(id).padStart(8, '0')}` })],
    })

  it('writes received messages in bulk and acks them', async () => {
    const queue = memoryQueue()
    const store = memoryStore()
    const calls: number[] = []
    const insertEvents = store.insertEvents
    store.insertEvents = async events => (calls.push(events.length), insertEvents(events))
    await queue.send([1, 2, 3, 4, 5].map(message))
    const stats = await work(queue, store)
    expect(await store.listEvents()).toHaveLength(5)
    expect(calls.length).toBeLessThan(5) // bulk writes
    expect(stats).toMatchObject({ received: 5, written: 5, retried: 0, deadLettered: 0 })
  })

  it('dead-letters undecodable messages at once; the rest are written', async () => {
    const queue = memoryQueue()
    const store = memoryStore()
    const onDeadLetter = vi.fn()
    await queue.send([message(1), 'not a message', message(2)])
    const worker = runWorker({ queue, store, waitMs: 20, logger: false, hooks: { onDeadLetter } })
    await vi.waitFor(() => expect(queue.size()).toBe(0), { timeout: 10_000 })
    await worker.stop()
    expect(await store.listEvents()).toHaveLength(2)
    expect(queue.deadLetters).toEqual([
      { body: 'not a message', reason: 'undeliverable: not JSON', attempts: 1 },
    ])
    expect(onDeadLetter).toHaveBeenCalledOnce()
  })

  it('survives a store outage: retries, pauses, and writes everything once when the store is back', async () => {
    const queue = memoryQueue()
    const store = memoryStore()
    let down = true
    const insertEvents = store.insertEvents
    store.insertEvents = async events => {
      if (down) throw new Error('store down')
      return insertEvents(events)
    }
    await queue.send([1, 2, 3].map(message))
    const worker = runWorker({
      queue,
      store,
      waitMs: 20,
      retryBaseMs: 10,
      outageBaseMs: 10,
      outageMaxMs: 40,
      logger: false,
    })
    await vi.waitFor(() => expect(worker.stats().retried).toBeGreaterThanOrEqual(6), {
      timeout: 10_000,
    })
    down = false
    await vi.waitFor(() => expect(queue.size()).toBe(0), { timeout: 10_000 })
    await worker.stop()
    expect(await store.listEvents()).toHaveLength(3)
    expect(queue.deadLetters).toEqual([])
  })

  it('dead-letters a message that keeps failing after maxAttempts', async () => {
    const queue = memoryQueue()
    const store = memoryStore()
    store.insertEvents = async () => {
      throw new Error('always fails')
    }
    await queue.send([message(1)])
    const worker = runWorker({
      queue,
      store,
      waitMs: 20,
      retryBaseMs: 5,
      outageBaseMs: 5,
      maxAttempts: 3,
      logger: false,
    })
    await vi.waitFor(() => expect(queue.deadLetters).toHaveLength(1), { timeout: 10_000 })
    await worker.stop()
    expect(queue.deadLetters[0]).toMatchObject({
      attempts: 3,
      reason: 'failed 3 times: always fails',
    })
  })

  it('stop() finishes the messages in hand (nothing is lost or left half-done)', async () => {
    const queue = memoryQueue()
    const store = memoryStore()
    let release!: () => void
    const insertEvents = store.insertEvents
    store.insertEvents = async events => {
      await new Promise<void>(resolve => (release = resolve))
      return insertEvents(events)
    }
    await queue.send([message(1)])
    const worker = runWorker({ queue, store, waitMs: 20, logger: false })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 10_000 })
    const stopping = worker.stop()
    release()
    await stopping
    expect(await store.listEvents()).toHaveLength(1)
    expect(queue.size()).toBe(0) // acked before stopping
  })

  it('survives a failing queue: receive, retry and ack errors are logged, nothing is lost', async () => {
    const inner = memoryQueue({ visibilityTimeoutMs: 100 })
    const store = memoryStore()
    const failures = { receive: 1, retry: 1, ack: 1 }
    const flaky: IngestQueue = {
      send: bodies => inner.send(bodies),
      async receive(options) {
        if (failures.receive-- > 0) throw new Error('receive failed')
        return inner.receive(options)
      },
      async retry(message, delay) {
        if (failures.retry-- > 0) throw new Error('retry failed')
        return inner.retry(message, delay)
      },
      async ack(messages) {
        if (failures.ack-- > 0) throw new Error('ack failed')
        return inner.ack(messages)
      },
      deadLetter: (message, reason) => inner.deadLetter(message, reason),
    }
    let fail = true
    const insertEvents = store.insertEvents
    store.insertEvents = async events => {
      if (fail) {
        fail = false
        throw new Error('first write fails')
      }
      return insertEvents(events)
    }
    const errors: string[] = []
    await inner.send([message(1)])
    const worker = runWorker({
      queue: flaky,
      store,
      waitMs: 20,
      retryBaseMs: 5,
      outageBaseMs: 5,
      logger: { debug() {}, info() {}, warn() {}, error: (_f, m) => errors.push(m) },
    })
    await vi.waitFor(() => expect(inner.size()).toBe(0), { timeout: 10_000 })
    await worker.stop()
    expect(await store.listEvents()).toHaveLength(1)
    expect(errors).toEqual(
      expect.arrayContaining([
        'queue receive failed',
        'queue retry/dead-letter failed',
        'queue ack failed; messages will be redelivered',
      ]),
    )
  })

  it('runs several receive loops in parallel', async () => {
    const queue = memoryQueue()
    const store = memoryStore()
    await queue.send(Array.from({ length: 40 }, (_, i) => message(i + 1)))
    const worker = runWorker({
      queue,
      store,
      waitMs: 20,
      batchSize: 5,
      concurrency: 4,
      logger: false,
    })
    await vi.waitFor(() => expect(queue.size()).toBe(0), { timeout: 10_000 })
    await worker.stop()
    expect(await store.listEvents({ limit: 100 })).toHaveLength(40)
  })
})
