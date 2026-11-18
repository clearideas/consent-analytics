// Site caching and chaining, the retention job, and NUL characters in props.
import { describe, expect, it, vi } from 'vitest'

import { toFetchHandler } from '../src/http/fetch.ts'
import type { Lock, SiteSource } from '../src/index.ts'
import {
  cachedSites,
  chainSites,
  compileDataPolicy,
  createCollector,
  defineSite,
  fixedGeo,
  memoryStore,
  purgeExpired,
  retentionCutoffs,
  startRetention,
  staticSites,
  strictDataPolicy,
} from '../src/index.ts'
import { storedEvent } from './support/store-conformance.ts'

const ORIGIN = 'https://www.example.com'

describe('cachedSites', () => {
  const counting = () => {
    const calls = { getSite: 0, isOriginAllowed: 0, isCredentialedOrigin: 0 }
    const site = defineSite({ siteKey: 'my-site', allowedOrigins: [ORIGIN], credentials: true })
    const source: SiteSource = {
      async getSite(key) {
        calls.getSite++
        await new Promise(resolve => setTimeout(resolve, 5))
        return key === 'my-site' ? site : null
      },
      async isOriginAllowed(origin) {
        calls.isOriginAllowed++
        return origin === ORIGIN
      },
      async isCredentialedOrigin(origin) {
        calls.isCredentialedOrigin++
        return origin === ORIGIN
      },
    }
    return { calls, source }
  }

  it('reuses answers within the TTL; unknown answers for a shorter time; shares concurrent lookups', async () => {
    let now = 0
    const { calls, source } = counting()
    const cached = cachedSites(source, { ttlMs: 1_000, negativeTtlMs: 100, clock: () => now })
    await Promise.all([
      cached.getSite('my-site'),
      cached.getSite('my-site'),
      cached.getSite('my-site'),
    ])
    expect(calls.getSite).toBe(1)
    await cached.getSite('unknown')
    now = 150
    await cached.getSite('my-site') // still fresh
    await cached.getSite('unknown') // negative answer expired
    expect(calls.getSite).toBe(3)
    now = 1_200
    await cached.getSite('my-site')
    expect(calls.getSite).toBe(4)
    expect(await cached.isOriginAllowed(ORIGIN)).toBe(true)
    expect(await cached.isOriginAllowed(ORIGIN)).toBe(true)
    expect(await cached.isCredentialedOrigin(ORIGIN)).toBe(true)
    expect(calls.isOriginAllowed).toBe(1)
  })

  it('does not cache failures; invalidate() forgets; the size is bounded', async () => {
    let fail = true
    const source: SiteSource = {
      getSite: async key => {
        if (fail) throw new Error('db down')
        return defineSite({ siteKey: key, allowedOrigins: [ORIGIN] })
      },
      isOriginAllowed: () => true,
    }
    const cached = cachedSites(source, { maxEntries: 2 })
    await expect(cached.getSite('site-1')).rejects.toThrow('db down')
    fail = false
    expect(await cached.getSite('site-1')).not.toBeNull()
    await cached.getSite('site-2')
    await cached.getSite('site-3') // evicts site-1
    fail = true
    await expect(cached.getSite('site-1')).rejects.toThrow('db down')
    expect(await cached.getSite('site-3')).not.toBeNull()
    cached.invalidate()
    await expect(cached.getSite('site-3')).rejects.toThrow('db down')
    expect(await cached.isCredentialedOrigin('https://x.example')).toBe(false) // source without the method
  })
})

describe('chainSites', () => {
  it('first source that knows the site wins; origins allowed by any source', async () => {
    const a = staticSites([
      { siteKey: 'site-a', allowedOrigins: ['https://a.example'], policyVersion: 'a' },
    ])
    const b = staticSites([
      { siteKey: 'site-a', allowedOrigins: ['https://a.example'], policyVersion: 'b' },
      { siteKey: 'site-b', allowedOrigins: ['https://b.example'], credentials: true },
    ])
    const chain = chainSites(a, b)
    expect((await chain.getSite('site-a'))!.policyVersion).toBe('a')
    expect((await chain.getSite('site-b'))!.siteKey).toBe('site-b')
    expect(await chain.getSite('site-c')).toBeNull()
    expect(await chain.isOriginAllowed('https://b.example')).toBe(true)
    expect(await chain.isOriginAllowed('https://c.example')).toBe(false)
    expect(await chain.isCredentialedOrigin('https://b.example')).toBe(true)
    expect(await chain.isCredentialedOrigin('https://a.example')).toBe(false)
  })
})

describe('retention', () => {
  it('cutoffs come from the profiles with retention settings', () => {
    const policy = strictDataPolicy()
    policy.profiles.consent!.retention = { events: '1mo', ip: '7d', consents: '1y' }
    expect(
      retentionCutoffs(compileDataPolicy(policy), new Date('2026-03-31T00:00:00.000Z')),
    ).toEqual([
      {
        profile: 'consent',
        eventsBefore: new Date('2026-02-28T00:00:00.000Z'),
        ipBefore: new Date('2026-03-24T00:00:00.000Z'),
        consentsBefore: new Date('2025-03-31T00:00:00.000Z'),
      },
    ])
  })

  it('purgeExpired needs a store that can purge', async () => {
    await expect(
      purgeExpired({ store: { insertEvents: vi.fn(), insertConsent: vi.fn() } }),
    ).rejects.toThrow(/does not support purging/)
    expect(await purgeExpired({ store: memoryStore() })).toEqual({
      eventsDeleted: 0,
      ipsRemoved: 0,
      rawUserAgentsRemoved: 0,
      consentsDeleted: 0,
    })
  })

  it('runs under a lock: only the holder purges', async () => {
    const store = memoryStore()
    await store.insertEvents([storedEvent({ retainUntil: '2000-01-01T00:00:00.000Z' })])
    let held = false
    const lock: Lock = {
      async acquire() {
        if (held) return null
        held = true
        return async () => {
          held = false
        }
      },
    }
    const first = startRetention({ store, lock, logger: false, runAtStart: false })
    const second = startRetention({ store, lock, logger: false, runAtStart: false })
    const [a, b] = await Promise.all([first.runNow(), second.runNow()])
    expect([a?.eventsDeleted, b]).toEqual([1, null])
    expect(held).toBe(false) // released
    await Promise.all([first.stop(), second.stop()])
  })

  it('a failing purge is logged and the job keeps its schedule', async () => {
    const store = memoryStore()
    store.purge = async () => {
      throw new Error('db down')
    }
    const error = vi.fn()
    const retention = startRetention({
      store,
      everyMs: 20,
      logger: { debug() {}, info() {}, warn() {}, error },
    })
    await vi.waitFor(() => expect(error.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 10_000,
    })
    await retention.stop()
    expect(error).toHaveBeenCalledWith(expect.anything(), 'retention purge failed')
  })
})

describe('NUL characters', () => {
  it('are removed from event props (keys and values) and flagged; a consent policyVersion with one is refused', async () => {
    const store = memoryStore()
    const handle = toFetchHandler(
      createCollector({
        sites: [{ siteKey: 'my-site', allowedOrigins: [ORIGIN] }],
        store,
        geo: fixedGeo({ country: 'US' }),
        logger: false,
      }),
    )
    const post = (path: string, body: unknown) =>
      handle(
        new Request(`http://collector.test${path}`, {
          method: 'POST',
          headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
          body: JSON.stringify(body),
        }),
      )
    const response = await post('/v1/events', {
      v: 1,
      siteKey: 'my-site',
      sentAt: '2026-11-10T12:00:01.000Z',
      events: [
        {
          eventId: 'event-00000001',
          name: 'sign_up',
          occurredAt: '2026-11-10T12:00:00.000Z',
          sessionId: 'session-0000001',
          trackingCategory: 'full',
          consent: { required: false, granted: false },
          props: { 'pl\u0000an': 'pr\u0000o', nested: [{ 'k\u0000': 'v\u0000' }] },
        },
      ],
    })
    expect(response.status).toBe(202)
    const [stored] = await store.listEvents()
    expect(stored!.props).toEqual({ plan: 'pro', nested: [{ k: 'v' }] })
    expect(stored!.sanitized).toEqual(['nul-characters-removed'])

    const consent = await post('/v1/consent', {
      v: 1,
      siteKey: 'my-site',
      consentId: 'consent-0000001',
      decision: 'granted',
      policyVersion: 'v\u00001',
      decidedAt: '2026-11-10T12:00:00.000Z',
      source: 'banner',
    })
    expect(consent.status).toBe(400)
    expect(await consent.json()).toMatchObject({
      errors: [{ path: '/policyVersion', message: 'must not contain NUL characters' }],
    })
  })
})
