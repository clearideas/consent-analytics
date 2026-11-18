// Sites, geo resolvers, the region policy, collector options and logging.
import { describe, expect, it, vi } from 'vitest'

import type { Logger, Site } from '../src/index.ts'
import {
  chainGeo,
  consentRecordId,
  consoleLogger,
  createCollector,
  defineSite,
  fixedGeo,
  headerReader,
  memoryStore,
  normalizeGeo,
  SiteConfigError,
  staticSites,
  trustedHeaderGeo,
} from '../src/index.ts'

const ORIGIN = 'https://www.example.com'

describe('sites', () => {
  it('defineSite fills defaults', () => {
    expect(defineSite({ siteKey: 'my-site', allowedOrigins: [ORIGIN] })).toEqual({
      siteKey: 'my-site',
      allowedOrigins: [ORIGIN],
      policyVersion: '1',
      consentMode: 'geo',
      trackingWithoutConsent: 'limited',
    })
    expect(
      defineSite({ siteKey: 'my-site', allowedOrigins: [ORIGIN], policyVersion: 3, name: 'Shop' }),
    ).toMatchObject({
      policyVersion: '3',
      name: 'Shop',
    })
  })

  it.each([
    [{ siteKey: 'x', allowedOrigins: [ORIGIN] }, /siteKey/],
    [{ siteKey: 'my-site', allowedOrigins: [] }, /allowedOrigins must be a non-empty array/],
    [{ siteKey: 'my-site', allowedOrigins: ['not a url'] }, /is not a URL/],
    [
      { siteKey: 'my-site', allowedOrigins: ['https://example.com/path'] },
      /exact origin like "https:\/\/example.com"/,
    ],
    [{ siteKey: 'my-site', allowedOrigins: ['https://EXAMPLE.com'] }, /exact origin/],
    [{ siteKey: 'my-site', allowedOrigins: [ORIGIN], consentMode: 'sometimes' }, /consentMode/],
    [
      { siteKey: 'my-site', allowedOrigins: [ORIGIN], trackingWithoutConsent: 'all' },
      /trackingWithoutConsent/,
    ],
    [{ siteKey: 'my-site', allowedOrigins: [ORIGIN], policyVersion: '' }, /policyVersion/],
    [
      { siteKey: 'my-site', allowedOrigins: [ORIGIN], policyVersion: 'v'.repeat(65) },
      /policyVersion/,
    ],
    [
      { siteKey: 'my-site', allowedOrigins: [ORIGIN], eventNames: { allow: ['Sign Up'] } },
      /eventNames\.allow/,
    ],
    [
      { siteKey: 'my-site', allowedOrigins: [ORIGIN], eventNames: { deny: 'sign_up' } },
      /eventNames\.deny/,
    ],
  ])('defineSite rejects %j', (input, message) => {
    expect(() => defineSite(input as any)).toThrow(SiteConfigError)
    expect(() => defineSite(input as any)).toThrow(message)
  })

  it('staticSites: lookups by key and origin; duplicate keys rejected; errors name the entry', () => {
    const sites = staticSites([
      { siteKey: 'site-a', allowedOrigins: [ORIGIN] },
      { siteKey: 'site-b', allowedOrigins: ['https://b.example', 'http://localhost:5173'] },
    ])
    expect((sites.getSite('site-b') as Site).allowedOrigins).toContain('https://b.example')
    expect(sites.getSite('site-c')).toBeNull()
    expect(sites.isOriginAllowed('http://localhost:5173')).toBe(true)
    expect(sites.isOriginAllowed('https://evil.example')).toBe(false)
    expect(() =>
      staticSites([
        { siteKey: 'site-a', allowedOrigins: [ORIGIN] },
        { siteKey: 'site-a', allowedOrigins: [ORIGIN] },
      ]),
    ).toThrow(/Duplicate siteKey "site-a"/)
    expect(() =>
      staticSites([{ siteKey: 'ok-site', allowedOrigins: [ORIGIN] }, { siteKey: '!' } as any]),
    ).toThrow(/sites\[1\]\.siteKey/)
    expect(() => staticSites('nope' as any)).toThrow(/array/)
  })

  it('staticSites does not share state with its input', () => {
    const input = { siteKey: 'site-a', allowedOrigins: [ORIGIN] }
    const sites = staticSites([input])
    input.allowedOrigins.push('https://late.example')
    expect(sites.isOriginAllowed('https://late.example')).toBe(false)
  })
})

describe('geo', () => {
  const headers = (values: Record<string, string>) => headerReader(values)

  it('normalizeGeo accepts ISO countries, upper-cases, drops placeholders and bad continents', () => {
    expect(normalizeGeo({ country: ' de ', continent: 'eu' })).toEqual({
      country: 'DE',
      continent: 'EU',
    })
    expect(normalizeGeo({ country: 'US', continent: 'Europe' })).toEqual({ country: 'US' })
    for (const country of ['XX', 'T1', 'EU', 'AP', 'A1', 'A2', 'O1', 'ZZ', 'DEU', '', undefined])
      expect(normalizeGeo({ country })).toBeNull()
    expect(normalizeGeo(null)).toBeNull()
  })

  it('trustedHeaderGeo: first trusted header with a real country; continent only from trusted headers', async () => {
    const geo = trustedHeaderGeo(['cloudfront-viewer-country', 'cf-ipcountry'], {
      continentHeaders: ['cf-ipcontinent'],
    })
    expect(
      await geo({ headers: headers({ 'cf-ipcountry': 'fr', 'cf-ipcontinent': 'EU' }) }),
    ).toEqual({
      country: 'FR',
      continent: 'EU',
    })
    expect(
      await geo({ headers: headers({ 'cloudfront-viewer-country': 'XX', 'cf-ipcountry': 'DE' }) }),
    ).toEqual({
      country: 'DE',
    })
    expect(
      await trustedHeaderGeo(['cf-ipcountry'])({
        headers: headers({ 'cf-ipcountry': 'DE', 'cf-ipcontinent': 'EU' }),
      }),
    ).toEqual({
      country: 'DE',
    })
    expect(await geo({ headers: headers({}) })).toBeNull()
  })

  it('trustedHeaderGeo never reads a continent header as a country (NA is Namibia)', async () => {
    // As configured from one list, e.g. TRUSTED_GEO_HEADERS=cf-ipcountry,cf-ipcontinent.
    const geo = trustedHeaderGeo(['cf-ipcountry', 'cf-ipcontinent'], {
      continentHeaders: ['cf-ipcontinent'],
    })
    for (const country of ['T1', 'XX', undefined]) {
      for (const continent of ['NA', 'AS', 'EU']) {
        const values: Record<string, string> = { 'cf-ipcontinent': continent }
        if (country) values['cf-ipcountry'] = country
        expect(await geo({ headers: headers(values) }), `${country} ${continent}`).toBeNull()
      }
    }
  })

  it('chainGeo: the first resolver that knows the country wins, in order', async () => {
    const calls: string[] = []
    const chain = chainGeo(
      () => (calls.push('a'), null),
      async () => (calls.push('b'), { country: 'XX' }),
      () => (calls.push('c'), { country: 'ca' }),
      () => (calls.push('d'), { country: 'US' }),
    )
    expect(await chain({ headers: headers({}) })).toEqual({ country: 'CA' })
    expect(calls).toEqual(['a', 'b', 'c'])
  })

  it('fixedGeo validates its country', async () => {
    expect(await fixedGeo({ country: 'us' })({ headers: headers({}) })).toEqual({ country: 'US' })
    expect(() => fixedGeo({ country: 'Germany' })).toThrow(/ISO 3166-1/)
  })
})

describe('createCollector options', () => {
  it('validates the store and contextTtlSeconds', () => {
    const sites = [{ siteKey: 'my-site', allowedOrigins: [ORIGIN] }]
    expect(() => createCollector({ sites, store: {} as any })).toThrow(/store/)
    for (const contextTtlSeconds of [-1, 86_401, 1.5]) {
      expect(() => createCollector({ sites, store: memoryStore(), contextTtlSeconds })).toThrow(
        /contextTtlSeconds/,
      )
    }
    expect(() =>
      createCollector({ sites: [{ siteKey: 'x', allowedOrigins: [] }], store: memoryStore() }),
    ).toThrow(SiteConfigError)
  })

  it('logs failures with the request ID, and a throwing onError hook never breaks the response', async () => {
    const entries: Array<[string, Record<string, unknown>, string]> = []
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (fields, message) => entries.push(['warn', fields, message]),
      error: (fields, message) => entries.push(['error', fields, message]),
    }
    const store = memoryStore()
    store.insertConsent = async () => {
      throw new Error('db down')
    }
    const collector = createCollector({
      sites: [{ siteKey: 'my-site', allowedOrigins: [ORIGIN] }],
      store,
      logger,
      hooks: {
        onError() {
          throw new Error('hook bug')
        },
      },
    })
    const response = await collector.handle({
      method: 'POST',
      path: '/v1/consent',
      query: new URLSearchParams(),
      headers: new Headers({
        Origin: ORIGIN,
        'Content-Type': 'text/plain',
        'X-Request-Id': 'req-1',
      }),
      readBody: async () =>
        new TextEncoder().encode(
          JSON.stringify({
            v: 1,
            siteKey: 'my-site',
            consentId: 'consent-0000001',
            decision: 'granted',
            policyVersion: '1',
            decidedAt: '2026-11-10T12:00:00.000Z',
            source: 'banner',
          }),
        ),
    })
    expect(response.status).toBe(503)
    expect(entries.map(([level, fields, message]) => [level, fields.requestId, message])).toEqual([
      ['error', 'req-1', 'store.insertConsent failed'],
      ['error', 'req-1', 'onError hook failed'],
    ])
    expect(JSON.stringify(entries)).not.toContain('consent-0000001') // no request data in logs
  })

  it('an unexpected error (e.g. in a custom rule) is a 500 problem, logged', async () => {
    const error = vi.fn()
    const collector = createCollector({
      sites: [{ siteKey: 'my-site', allowedOrigins: [ORIGIN] }],
      store: memoryStore(),
      rules: {
        custom: [
          () => {
            throw new Error('rule bug')
          },
        ],
      },
      logger: { debug() {}, info() {}, warn() {}, error },
    })
    const response = await collector.handle({
      method: 'POST',
      path: '/v1/events',
      query: new URLSearchParams(),
      headers: new Headers({ Origin: ORIGIN, 'Content-Type': 'text/plain' }),
      readBody: async () =>
        new TextEncoder().encode(
          JSON.stringify({
            v: 1,
            siteKey: 'my-site',
            sentAt: '2026-11-10T12:00:01.000Z',
            events: [
              {
                eventId: 'event-00000001',
                name: 'page_view',
                occurredAt: '2026-11-10T12:00:00.000Z',
                sessionId: 'session-0000001',
                trackingCategory: 'limited',
                consent: { required: true, granted: false },
                props: {},
              },
            ],
          }),
        ),
    })
    expect(response.status).toBe(500)
    expect(response.headers['Content-Type']).toBe('application/problem+json')
    expect(error).toHaveBeenCalledOnce()
  })
})

describe('consoleLogger', () => {
  it('writes JSON lines at and above its level', () => {
    const write = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = consoleLogger('warn')
    logger.info({ a: 1 }, 'hidden')
    logger.warn({ a: 2 }, 'shown')
    expect(write).toHaveBeenCalledOnce()
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({
      level: 'warn',
      msg: 'shown',
      a: 2,
    })
  })
})

describe('consentRecordId', () => {
  const record = {
    v: 1 as const,
    siteKey: 'my-site',
    consentId: 'consent-0000001',
    decision: 'partial' as const,
    categories: { preferences: false, statistics: true, marketing: false },
    policyVersion: '1',
    decidedAt: '2026-11-10T12:00:00.000Z',
    source: 'banner' as const,
  }

  it('is stable for the same natural key and differs when any part of it differs', () => {
    const id = consentRecordId('my-site', record)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    // Property order in the categories object does not matter.
    expect(
      consentRecordId('my-site', {
        ...record,
        categories: { marketing: false, statistics: true, preferences: false },
      }),
    ).toBe(id)
    const variants = [
      consentRecordId('other-site', record),
      consentRecordId('my-site', { ...record, consentId: 'consent-0000002' }),
      consentRecordId('my-site', { ...record, decidedAt: '2026-11-10T12:00:00.001Z' }),
      consentRecordId('my-site', { ...record, decision: 'granted' }),
      consentRecordId('my-site', {
        ...record,
        categories: { ...record.categories, marketing: true },
      }),
      consentRecordId('my-site', { ...record, categories: undefined }),
      consentRecordId('my-site', { ...record, policyVersion: '2' }),
    ]
    expect(new Set([id, ...variants]).size).toBe(8)
  })
})
