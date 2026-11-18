// The phase-2 pipeline end to end, through a collector: data policy profile by region,
// server enrichment per profile, rules, normalization and retention, as stored.
import { describe, expect, it } from 'vitest'

import { toFetchHandler } from '../src/http/fetch.ts'
import type { CollectorOptions, DataPolicyDocument, Geo } from '../src/index.ts'
import { balancedDataPolicy, createCollector, memoryStore, strictDataPolicy } from '../src/index.ts'

const ORIGIN = 'https://www.example.com'
const NOW = '2026-11-10T12:00:05.000Z'
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// Visitor locations by test header (a stand-in for an IP lookup service).
const LOCATIONS: Record<string, Geo> = {
  brazil: {
    country: 'BR',
    continent: 'SA',
    region: 'São Paulo',
    regionCode: 'BR-SP',
    city: 'São Paulo',
    latitude: -23.55,
    longitude: -46.63,
    asn: 'AS28573',
    org: 'Claro S.A.',
    privacy: { vpn: false },
  },
  germany: {
    country: 'DE',
    continent: 'EU',
    city: 'Berlin',
    asn: 'AS3320',
    org: 'Deutsche Telekom AG',
  },
  california: {
    country: 'US',
    continent: 'NA',
    regionCode: 'US-CA',
    city: 'San Francisco',
    asn: 'AS7922',
    org: 'Comcast',
  },
}

function setup(overrides: Partial<CollectorOptions> = {}) {
  const store = memoryStore()
  const collector = createCollector({
    sites: [{ siteKey: 'my-site', allowedOrigins: [ORIGIN], policyVersion: '2026-11-01' }],
    store,
    geo: ({ headers }) => {
      const where = headers.get('x-test-location')
      if (where === 'fail') throw new Error('lookup failed')
      return where ? LOCATIONS[where] : null
    },
    clock: () => new Date(NOW),
    logger: false,
    ...overrides,
  })
  const handle = toFetchHandler(collector, { getClientIp: () => '203.0.113.77' })
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await handle(
      new Request(`http://collector.test${path}`, {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'Content-Type': 'text/plain',
          'User-Agent': CHROME,
          'Accept-Language': 'pt-BR,pt;q=0.9',
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    )
    return { status: response.status, body: await response.json() }
  }
  const context = async (location?: string) => {
    const response = await handle(
      new Request('http://collector.test/v1/context?siteKey=my-site', {
        headers: location ? { 'x-test-location': location } : {},
      }),
    )
    return ((await response.json()) as { policy: Record<string, unknown> }).policy
  }
  return { store, post, context }
}

let seq = 0
const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: `event-${String(++seq).padStart(10, '0')}`,
  name: 'page_view',
  occurredAt: '2026-11-10T12:00:00.000Z',
  sessionId: 'session-0000001',
  trackingCategory: 'full',
  consent: { required: false, granted: false },
  props: {
    url: 'https://www.example.com/pricing?plan=pro',
    path: '/pricing',
    title: 'Pricing',
    userAgent: CHROME,
  },
  ...overrides,
})
const batch = (...events: unknown[]) => ({
  v: 1,
  siteKey: 'my-site',
  sentAt: '2026-11-10T12:00:01.000Z',
  events,
})

describe('balanced policy (the default)', () => {
  it('no consent required (Brazil): everything is stored, with 36-month retention', async () => {
    const { post, store } = setup()
    expect((await post('/v1/events', batch(event()), { 'x-test-location': 'brazil' })).status).toBe(
      202,
    )
    const [stored] = await store.listEvents()
    expect(stored).toMatchObject({
      trackingCategory: 'full',
      profile: 'open',
      page: { url: 'https://www.example.com/pricing?plan=pro', path: '/pricing', title: 'Pricing' },
      client: { userAgent: CHROME },
      server: {
        ip: '203.0.113.77',
        ipForm: 'full',
        geo: {
          country: 'BR',
          continent: 'SA',
          region: 'São Paulo',
          regionCode: 'BR-SP',
          city: 'São Paulo',
          latitude: -23.55,
          longitude: -46.63,
        },
        network: { asn: 'AS28573', org: 'Claro S.A.' },
        userAgent: {
          browser: 'Chrome',
          browserVersion: '131',
          os: 'Windows',
          device: 'desktop',
          isBot: false,
          raw: CHROME,
        },
        language: 'pt-BR',
        gpc: false,
        privacy: { vpn: false },
      },
      retainUntil: '2029-11-10T12:00:05.000Z',
      ipRetainUntil: '2027-05-09T12:00:05.000Z',
      rawUserAgentRetainUntil: '2027-05-09T12:00:05.000Z',
    })
    expect(stored).not.toHaveProperty('sanitized')
  })

  it('consent region (Germany): the minimum without consent, everything with it; 25 months / 30 days', async () => {
    const { post, store } = setup()
    const without = event({
      trackingCategory: 'limited',
      consent: { required: true, granted: false },
      props: { path: '/pricing' },
    })
    const withConsent = event({ consent: { required: true, granted: true } })
    await post('/v1/events', batch(without, withConsent), { 'x-test-location': 'germany' })
    const [limited, full] = await store.listEvents()

    expect(limited!.server).toEqual({
      geo: { country: 'DE', continent: 'EU' },
      userAgent: { device: 'desktop' },
      language: 'pt-BR',
      gpc: false,
    })
    expect(limited).toMatchObject({ profile: 'gdpr', retainUntil: '2028-12-10T12:00:05.000Z' })
    expect(limited).not.toHaveProperty('ipRetainUntil')
    expect(JSON.stringify(limited)).not.toContain('203.0.113')

    expect(full).toMatchObject({
      profile: 'gdpr',
      server: {
        ip: '203.0.113.77',
        network: { org: 'Deutsche Telekom AG' },
        userAgent: { raw: CHROME },
      },
      ipRetainUntil: '2026-12-10T12:00:05.000Z',
      rawUserAgentRetainUntil: '2026-12-10T12:00:05.000Z',
    })
  })

  it('US privacy state with Global Privacy Control: no IP address, network by ASN only', async () => {
    const { post, store } = setup()
    await post('/v1/events', batch(event()), { 'x-test-location': 'california', 'Sec-GPC': '1' })
    const [stored] = await store.listEvents()
    expect(stored).toMatchObject({
      profile: 'us-privacy',
      server: { gpc: true, network: { asn: 'AS7922' } },
    })
    expect(stored!.server).not.toHaveProperty('ip')
    expect(stored!.server!.network).not.toHaveProperty('org')
    expect(stored).not.toHaveProperty('ipRetainUntil')
  })

  it('the rules apply: a full event without consent in a consent region is stored limited', async () => {
    const { post, store } = setup()
    const { body } = await post(
      '/v1/events',
      batch(
        event(),
        event({
          name: 'sign_up',
          trackingCategory: 'limited',
          consent: { required: true, granted: false },
        }),
      ),
      { 'x-test-location': 'germany' },
    )
    expect(body).toEqual({
      accepted: 1,
      duplicates: 0,
      rejected: [
        {
          index: 1,
          eventId: expect.any(String),
          errors: [{ path: '/name', message: 'this event is not collected without consent' }],
        },
      ],
    })
    const [stored] = await store.listEvents()
    expect(stored).toMatchObject({
      trackingCategory: 'limited',
      props: { url: 'https://www.example.com/pricing', path: '/pricing', title: 'Pricing' },
      sanitized: ['downgraded-to-limited', 'limited-props-removed', 'limited-url-reduced'],
    })
    expect(stored!.server).not.toHaveProperty('ip')
    expect(stored).not.toHaveProperty('client') // userAgent prop removed: not allowed in limited events
  })

  it('an unknown region (no answer, or a failed lookup) is treated as a consent region', async () => {
    const cases: Array<Record<string, string>> = [{}, { 'x-test-location': 'fail' }]
    for (const headers of cases) {
      const { post, store } = setup()
      await post('/v1/events', batch(event()), headers)
      expect((await store.listEvents())[0]).toMatchObject({
        profile: 'gdpr',
        trackingCategory: 'limited',
        sanitized: expect.arrayContaining(['downgraded-to-limited']),
      })
    }
  })

  it('consent records: profile, annotations and 5-year retention; never an IP address', async () => {
    const { post, store } = setup()
    const record = {
      v: 1,
      siteKey: 'my-site',
      consentId: 'consent-0000001',
      decision: 'granted',
      categories: { preferences: true, statistics: false, marketing: true },
      policyVersion: '2026-01-01',
      decidedAt: '2026-11-10T12:00:00.000Z',
      source: 'banner',
    }
    expect((await post('/v1/consent', record, { 'x-test-location': 'germany' })).status).toBe(201)
    const [stored] = await store.listConsents()
    expect(stored).toMatchObject({
      profile: 'gdpr',
      annotations: ['decision-categories-mismatch', 'policy-version-not-current'],
      retainUntil: '2031-11-10T12:00:05.000Z',
      categories: record.categories, // stored as received
    })
    expect(JSON.stringify(stored)).not.toContain('203.0.113')
  })

  it('the consent policy sent to browsers comes from the profile', async () => {
    const { context } = setup()
    expect(await context('germany')).toMatchObject({ consentRequired: true, reason: 'region' })
    expect(await context('california')).toMatchObject({ consentRequired: false, reason: 'region' })
    expect(await context()).toMatchObject({ consentRequired: true, reason: 'unknown-region' })
  })
})

describe('other policies', () => {
  it('strict: nothing beyond what the browser sent, no retention dates', async () => {
    const { post, store } = setup({ dataPolicy: strictDataPolicy() })
    await post('/v1/events', batch(event()), { 'x-test-location': 'brazil' })
    const [stored] = await store.listEvents()
    expect(stored).toMatchObject({ profile: 'no-consent', page: { path: '/pricing' } })
    for (const key of ['server', 'retainUntil', 'ipRetainUntil'])
      expect(stored).not.toHaveProperty(key)
  })

  it('hashed IP addresses need a hash secret', async () => {
    const policy = balancedDataPolicy()
    policy.profiles.open!.collect!.full!.ip = 'hashed'
    expect(() => setup({ dataPolicy: policy })).toThrow(/hashSecret/)
    const { post, store } = setup({
      dataPolicy: policy,
      hashSecret: 'a-secret-of-at-least-16-chars',
    })
    await post('/v1/events', batch(event()), { 'x-test-location': 'brazil' })
    expect((await store.listEvents())[0]!.server).toMatchObject({
      ip: expect.stringMatching(/^[\w-]{22}$/),
      ipForm: 'hashed',
    })
  })

  it('clientProps.deny drops browser props before storing (and from the projection)', async () => {
    const policy: DataPolicyDocument = balancedDataPolicy()
    policy.profiles.open!.collect!.full!.clientProps = { deny: ['userAgent', 'title'] }
    const { post, store } = setup({ dataPolicy: policy })
    await post('/v1/events', batch(event()), { 'x-test-location': 'brazil' })
    const [stored] = await store.listEvents()
    expect(stored!.props).toEqual({
      url: 'https://www.example.com/pricing?plan=pro',
      path: '/pricing',
    })
    expect(stored).not.toHaveProperty('client')
    expect(stored!.page).not.toHaveProperty('title')
    expect(stored!.sanitized).toEqual(['client-props-denied'])
  })

  it('an invalid data policy fails at startup with every problem listed', () => {
    expect(() => setup({ dataPolicy: { version: 1, profiles: {}, rules: [] } as any })).toThrow(
      /Invalid data policy:\n {2}- \/profiles: must NOT have fewer than 1 properties\n {2}- \/rules/,
    )
  })
})
