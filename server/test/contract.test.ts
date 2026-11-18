// Contract tests: the collector against spec/openapi.yaml, through every transport.
// Every response to a spec operation is checked against the schema the spec declares for
// its status code. (Ported from sample-host/test/contract.test.ts and extended.)
import { afterEach, describe, expect, it } from 'vitest'

import type { CollectorOptions, CollectorStore, SiteInput } from '../src/index.ts'
import {
  createCollector,
  EVENTS_MAX_BYTES,
  memoryStore,
  strictDataPolicy,
  trustedHeaderGeo,
} from '../src/index.ts'
import { expectMatchesSpec, responseSchema, spec } from './support/spec.ts'
import type { Connection } from './support/transports.ts'
import { TRANSPORTS } from './support/transports.ts'

const ORIGIN = 'https://www.example.com'
const SITE: SiteInput = {
  siteKey: 'example-site',
  allowedOrigins: [ORIGIN],
  policyVersion: '2026-11-01',
  consentMode: 'geo',
}
const NOW = '2026-11-10T12:00:05.000Z'

let seq = 0
function event(overrides: Record<string, unknown> = {}) {
  seq++
  return {
    eventId: `evt${String(seq).padStart(21, '0')}`,
    name: 'page_view',
    occurredAt: '2026-11-10T12:00:00.000Z',
    sessionId: 'sess0000000000000000000001',
    pageViewId: 'pv000000000000000000000001',
    trackingCategory: 'full',
    consent: { required: false, granted: false },
    props: { url: 'https://www.example.com/pricing', path: '/pricing' },
    ...overrides,
  }
}

function batch(events: unknown[], overrides: Record<string, unknown> = {}) {
  return { v: 1, siteKey: SITE.siteKey, sentAt: '2026-11-10T12:00:01.000Z', events, ...overrides }
}

function consentRecord(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    siteKey: SITE.siteKey,
    consentId: 'consent00000000000000001',
    decision: 'granted',
    policyVersion: '2026-11-01',
    decidedAt: '2026-11-10T12:00:04.000Z',
    source: 'banner',
    ...overrides,
  }
}

describe('spec document', () => {
  it('every operation has an operationId and every response is declared with a schema', () => {
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const [method, operation] of Object.entries<any>(item)) {
        expect(operation.operationId, `${method} ${path}`).toBeTruthy()
        for (const status of Object.keys(operation.responses)) {
          expect(() => responseSchema(path, method, Number(status))).not.toThrow()
        }
      }
    }
  })
})

describe.each(TRANSPORTS)('$name', transport => {
  const open: Connection[] = []
  afterEach(async () => {
    await Promise.all(open.splice(0).map(connection => connection.close()))
  })

  async function host(overrides: Partial<CollectorOptions> = {}) {
    const store = memoryStore()
    const collector = createCollector({
      sites: [SITE],
      store,
      geo: trustedHeaderGeo(['cf-ipcountry'], { continentHeaders: ['cf-ipcontinent'] }),
      clock: () => new Date(NOW),
      logger: false,
      ...overrides,
    })
    const connection = await transport.connect(collector)
    open.push(connection)

    /** Send a request like a browser would; the response must match the spec. */
    async function call(
      method: 'GET' | 'POST',
      path: string,
      init: {
        body?: unknown
        raw?: string
        contentType?: string
        origin?: string | null
        headers?: Record<string, string>
      } = {},
    ) {
      const headers: Record<string, string> = { ...init.headers }
      if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN
      if (method === 'POST')
        headers['Content-Type'] = init.contentType ?? 'text/plain;charset=UTF-8'
      const response = await connection.request(path, {
        method,
        headers,
        body: method === 'POST' ? (init.raw ?? JSON.stringify(init.body)) : undefined,
      })
      const body = response.text ? JSON.parse(response.text) : undefined
      expectMatchesSpec(
        path.split('?')[0]!,
        method,
        response.status,
        response.headers.get('content-type'),
        body,
      )
      return { response, body }
    }

    return { store, connection, call }
  }

  describe('GET /v1/health', () => {
    it('returns ok', async () => {
      const { call } = await host()
      const { response, body } = await call('GET', '/v1/health', { origin: null })
      expect(response.status).toBe(200)
      expect(body).toEqual({ status: 'ok' })
    })
  })

  describe('GET /v1/context', () => {
    it('returns the policy for a consent-required region with no-store caching', async () => {
      const { call } = await host()
      const { response, body } = await call('GET', '/v1/context?siteKey=example-site', {
        headers: { 'cf-ipcountry': 'DE', 'cf-ipcontinent': 'EU' },
      })
      expect(response.status).toBe(200)
      expect(body).toEqual({
        v: 1,
        siteKey: 'example-site',
        policy: {
          consentRequired: true,
          policyVersion: '2026-11-01',
          trackingWithoutConsent: 'limited',
          reason: 'region',
        },
        geo: { country: 'DE', continent: 'EU' },
        ttlSeconds: 3600,
      })
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    })

    it('does not require consent outside the consent region', async () => {
      const { call } = await host()
      const { body } = await call('GET', '/v1/context?siteKey=example-site', {
        headers: { 'cf-ipcountry': 'US' },
      })
      expect(body.policy).toMatchObject({ consentRequired: false, reason: 'region' })
      expect(body.geo).toEqual({ country: 'US' })
    })

    it('requires consent when the region is unknown (fail closed)', async () => {
      const { call } = await host()
      const cases: Array<Record<string, string>> = [
        {},
        { 'cf-ipcountry': 'XX' },
        { 'cf-ipcountry': 'T1' },
        { 'cf-ipcountry': 'not-a-country' },
      ]
      for (const headers of cases) {
        const { body } = await call('GET', '/v1/context?siteKey=example-site', { headers })
        expect(body.policy).toMatchObject({ consentRequired: true, reason: 'unknown-region' })
        expect(body.geo).toBeUndefined()
      }
    })

    it('requires consent when no geo resolver is configured, or when it fails', async () => {
      for (const geo of [
        undefined,
        () => {
          throw new Error('lookup service down')
        },
      ]) {
        const { call } = await host({ geo })
        const { response, body } = await call('GET', '/v1/context?siteKey=example-site', {
          headers: { 'cf-ipcountry': 'US' },
        })
        expect(response.status).toBe(200)
        expect(body.policy).toMatchObject({ consentRequired: true, reason: 'unknown-region' })
      }
    })

    it('ignores geo headers that are not configured as trusted (clients could spoof them)', async () => {
      const { call } = await host({ geo: trustedHeaderGeo([]) })
      const { body } = await call('GET', '/v1/context?siteKey=example-site', {
        headers: { 'cf-ipcountry': 'US' },
      })
      expect(body.policy).toMatchObject({ consentRequired: true, reason: 'unknown-region' })
    })

    it('applies site-level consent modes regardless of region', async () => {
      const always = await host({ sites: [{ ...SITE, consentMode: 'always' }] })
      const never = await host({ sites: [{ ...SITE, consentMode: 'never' }] })
      const us = { headers: { 'cf-ipcountry': 'US' } }
      const de = { headers: { 'cf-ipcountry': 'DE' } }
      expect(
        (await always.call('GET', '/v1/context?siteKey=example-site', us)).body.policy,
      ).toMatchObject({
        consentRequired: true,
        reason: 'site',
      })
      expect(
        (await never.call('GET', '/v1/context?siteKey=example-site', de)).body.policy,
      ).toMatchObject({
        consentRequired: false,
        reason: 'site',
      })
    })

    it('accepts same-origin requests without an Origin header', async () => {
      const { call } = await host()
      const { response } = await call('GET', '/v1/context?siteKey=example-site', { origin: null })
      expect(response.status).toBe(200)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it('echoes allowed origins for CORS and never allows credentials', async () => {
      const { call } = await host()
      const { response } = await call('GET', '/v1/context?siteKey=example-site')
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
      expect(response.headers.get('Vary')).toContain('Origin')
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    })

    it('rejects bad site keys, unknown sites and foreign origins', async () => {
      const { call } = await host()
      expect((await call('GET', '/v1/context')).response.status).toBe(400)
      expect((await call('GET', '/v1/context?siteKey=a%20b')).response.status).toBe(400)
      expect((await call('GET', '/v1/context?siteKey=unknown-site')).response.status).toBe(404)
      const foreign = await call('GET', '/v1/context?siteKey=example-site', {
        origin: 'https://evil.example',
      })
      expect(foreign.response.status).toBe(403)
      expect(foreign.response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it('applies per-country and per-site "no tracking without consent"', async () => {
      const strictCountries = await host({
        dataPolicy: strictDataPolicy({ noTrackingWithoutConsentCountries: ['DE'] }),
      })
      const policyFor = async (country: string) =>
        (
          await strictCountries.call('GET', '/v1/context?siteKey=example-site', {
            headers: { 'cf-ipcountry': country },
          })
        ).body.policy
      expect(await policyFor('DE')).toMatchObject({
        consentRequired: true,
        trackingWithoutConsent: 'none',
      })
      expect(await policyFor('FR')).toMatchObject({
        consentRequired: true,
        trackingWithoutConsent: 'limited',
      })

      const strictSite = await host({ sites: [{ ...SITE, trackingWithoutConsent: 'none' }] })
      const { body } = await strictSite.call('GET', '/v1/context?siteKey=example-site', {
        headers: { 'cf-ipcountry': 'FR' },
      })
      expect(body.policy.trackingWithoutConsent).toBe('none')
    })
  })

  describe('POST /v1/events', () => {
    it('accepts text/plain, text/plain;charset=UTF-8 and application/json bodies', async () => {
      const { call } = await host()
      for (const contentType of ['text/plain', 'text/plain;charset=UTF-8', 'application/json']) {
        const { response, body } = await call('POST', '/v1/events', {
          body: batch([event()]),
          contentType,
        })
        expect(response.status, contentType).toBe(202)
        expect(body).toEqual({ accepted: 1, duplicates: 0, rejected: [] })
      }
    })

    it('stores events with the server receive time, corrected time, origin and profile', async () => {
      // The strict policy stores nothing beyond what the browser sent: the base shape.
      const { call, store } = await host({ dataPolicy: strictDataPolicy() })
      const e = event({ trackingCategory: 'limited', consent: { required: true, granted: false } })
      await call('POST', '/v1/events', { body: batch([e]) })
      expect(await store.listEvents({ siteKey: SITE.siteKey })).toEqual([
        {
          siteKey: SITE.siteKey,
          eventId: e.eventId,
          name: 'page_view',
          occurredAt: '2026-11-10T12:00:00.000Z',
          // Skew-corrected: received 4 s after the client's sentAt.
          occurredAtCorrected: '2026-11-10T12:00:04.000Z',
          sentAt: '2026-11-10T12:00:01.000Z',
          receivedAt: NOW,
          sessionId: e.sessionId,
          pageViewId: e.pageViewId,
          trackingCategory: 'limited',
          consent: { required: true, granted: false },
          props: e.props,
          page: { url: 'https://www.example.com/pricing', path: '/pricing' },
          origin: ORIGIN,
          profile: 'consent', // region unknown: the consent-required profile
        },
      ])
    })

    it('is idempotent: a repeated eventId is a duplicate, not an error', async () => {
      const { call, store } = await host()
      const e = event()
      await call('POST', '/v1/events', { body: batch([e]) })
      const { response, body } = await call('POST', '/v1/events', { body: batch([e, event(), e]) })
      expect(response.status).toBe(202)
      expect(body).toEqual({ accepted: 1, duplicates: 2, rejected: [] })
      expect(await store.listEvents()).toHaveLength(2)
    })

    it('accepts the valid events of a batch and reports the invalid ones', async () => {
      const { call, store } = await host()
      const good = event()
      const { response, body } = await call('POST', '/v1/events', {
        body: batch([
          good,
          event({ name: 'Not Valid' }),
          { eventId: 'short' },
          event({ props: { s: 'x'.repeat(2049) } }),
        ]),
      })
      expect(response.status).toBe(202)
      expect(body.accepted).toBe(1)
      expect(body.rejected.map((r: any) => r.index)).toEqual([1, 2, 3])
      expect(body.rejected[0].errors[0].path).toBe('/name')
      expect(body.rejected[1].eventId).toBe('short')
      expect(body.rejected[2].errors[0].path).toBe('/props/s')
      expect((await store.listEvents()).map(e => e.eventId)).toEqual([good.eventId])
    })

    it('rejects an invalid envelope as a whole', async () => {
      const { call, store } = await host()
      for (const body of [
        batch([event()], { v: 2 }),
        batch([]),
        batch(Array.from({ length: 51 }, () => event())),
        batch([event()], { sentAt: 'yesterday' }),
        batch([event()], { extra: true }),
        batch([null]),
      ]) {
        expect((await call('POST', '/v1/events', { body })).response.status).toBe(400)
      }
      expect(await store.listEvents()).toEqual([])
    })

    it('rejects malformed JSON and invalid UTF-8 (400), unknown sites (404), other media types (415)', async () => {
      const { call, connection } = await host()
      expect((await call('POST', '/v1/events', { raw: '{not json' })).response.status).toBe(400)
      expect((await call('POST', '/v1/events', { raw: '' })).response.status).toBe(400)
      const invalidUtf8 = await connection.request('/v1/events', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
        body: new Uint8Array([0x7b, 0xff, 0x7d]),
      })
      expect(invalidUtf8.status).toBe(400)
      expect(
        (await call('POST', '/v1/events', { body: batch([event()], { siteKey: 'unknown-site' }) }))
          .response.status,
      ).toBe(404)
      expect(
        (await call('POST', '/v1/events', { body: batch([event()], { siteKey: 'x' }) })).response
          .status,
      ).toBe(400)
      for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data', '']) {
        const { response } = await call('POST', '/v1/events', {
          body: batch([event()]),
          contentType,
        })
        expect(response.status, contentType).toBe(415)
      }
    })

    it('requires an allowed Origin', async () => {
      const { call, store } = await host()
      expect(
        (await call('POST', '/v1/events', { body: batch([event()]), origin: null })).response
          .status,
      ).toBe(403)
      const foreign = await call('POST', '/v1/events', {
        body: batch([event()]),
        origin: 'https://evil.example',
      })
      expect(foreign.response.status).toBe(403)
      expect(foreign.response.headers.get('Access-Control-Allow-Origin')).toBeNull()
      expect(await store.listEvents()).toHaveLength(0)
    })

    it('rejects bodies over 64 KiB with 413', async () => {
      const { call } = await host()
      const raw = JSON.stringify(batch([event({ props: { pad: 'x'.repeat(EVENTS_MAX_BYTES) } })]))
      const { response } = await call('POST', '/v1/events', { raw })
      expect(response.status).toBe(413)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    })
  })

  describe('POST /v1/consent', () => {
    it('stores an append-only record and returns its id', async () => {
      const { call, store } = await host()
      const { response, body } = await call('POST', '/v1/consent', { body: consentRecord() })
      await call('POST', '/v1/consent', {
        body: consentRecord({ decision: 'denied', decidedAt: '2026-11-10T12:10:00.000Z' }),
      })

      expect(response.status).toBe(201)
      expect(body).toMatchObject({ consentId: 'consent00000000000000001', recordedAt: NOW })
      const records = await store.listConsents({ siteKey: SITE.siteKey })
      expect(records.map(r => r.decision)).toEqual(['granted', 'denied'])
      expect(records[0]).toMatchObject({
        recordId: body.recordId,
        origin: ORIGIN,
        categories: null,
      })
      expect(records[0]).not.toHaveProperty('ip')
    })

    it('a retried record (identical body) is stored once and gets the same recordId', async () => {
      let now = NOW
      const { call, store } = await host({ clock: () => new Date(now) })
      const first = await call('POST', '/v1/consent', { body: consentRecord() })
      now = '2026-11-10T12:30:00.000Z'
      const retry = await call('POST', '/v1/consent', { body: consentRecord() })
      expect(retry.response.status).toBe(201)
      expect(retry.body).toEqual(first.body) // same recordId and the original recordedAt
      expect(await store.listConsents()).toHaveLength(1)
      // A different decision (or time) is a new record.
      const changed = await call('POST', '/v1/consent', {
        body: consentRecord({ decision: 'denied' }),
      })
      expect(changed.body.recordId).not.toBe(first.body.recordId)
      expect(await store.listConsents()).toHaveLength(2)
    })

    it('records partial decisions with their categories', async () => {
      const { call, store } = await host()
      const categories = { preferences: false, statistics: true, marketing: false }
      const { response } = await call('POST', '/v1/consent', {
        body: consentRecord({ decision: 'partial', categories }),
      })
      expect(response.status).toBe(201)
      expect((await store.listConsents())[0]).toMatchObject({ decision: 'partial', categories })
    })

    it('validates the record', async () => {
      const { call } = await host()
      for (const body of [
        consentRecord({ decision: 'maybe' }),
        consentRecord({ consentId: 'x' }),
        consentRecord({ policyVersion: '' }),
        consentRecord({ source: 'server' }),
        consentRecord({ categories: { statistics: true } }),
        consentRecord({ categories: { preferences: 1, statistics: true, marketing: false } }),
      ]) {
        expect((await call('POST', '/v1/consent', { body })).response.status).toBe(400)
      }
    })

    it('rejects bodies over 4 KiB with 413', async () => {
      const { call } = await host()
      const raw = JSON.stringify(consentRecord()).replace(
        '"v":1',
        `"v":1,"pad":"${'x'.repeat(5000)}"`,
      )
      expect((await call('POST', '/v1/consent', { raw })).response.status).toBe(413)
    })
  })

  describe('storage and site lookup failures', () => {
    const failing = (): CollectorStore => ({
      insertEvents: async () => {
        throw new Error('database down')
      },
      insertConsent: async () => {
        throw new Error('database down')
      },
    })

    it('answer 503 with Retry-After and CORS, so clients retry (and report the error)', async () => {
      const errors: string[] = []
      const { call } = await host({
        store: failing(),
        retryAfterSeconds: 7,
        hooks: { onError: (_error, { operation }) => errors.push(operation) },
      })
      for (const [path, body] of [
        ['/v1/events', batch([event()])],
        ['/v1/consent', consentRecord()],
      ] as const) {
        const { response } = await call('POST', path, { body })
        expect(response.status, path).toBe(503)
        expect(response.headers.get('Retry-After')).toBe('7')
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
      }
      expect(errors).toEqual(['store.insertEvents', 'store.insertConsent'])
    })

    it('a failing site source also answers 503', async () => {
      const { call } = await host({
        sites: {
          getSite: async () => {
            throw new Error('sites table unavailable')
          },
          isOriginAllowed: async () => true,
        },
      })
      expect((await call('GET', '/v1/context?siteKey=example-site')).response.status).toBe(503)
      expect((await call('POST', '/v1/events', { body: batch([event()]) })).response.status).toBe(
        503,
      )
    })

    it('a failing origin lookup is logged and treated as not allowed (no CORS headers, no crash)', async () => {
      const errors: string[] = []
      const { call, connection } = await host({
        sites: {
          getSite: async () => {
            throw new Error('sites table unavailable')
          },
          isOriginAllowed: async () => {
            throw new Error('sites table unavailable')
          },
        },
        logger: {
          debug() {},
          info() {},
          warn() {},
          error: (_fields, message) => errors.push(message),
        },
      })
      const { response } = await call('POST', '/v1/events', { body: batch([event()]) })
      expect(response.status).toBe(503)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
      const preflight = await connection.request('/v1/events', {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN },
      })
      expect(preflight.status).toBe(403)
      expect(errors).toContain('site lookup failed')
    })

    it('a batch with only invalid events does not touch the store', async () => {
      const { call } = await host({ store: failing() })
      const { response, body } = await call('POST', '/v1/events', {
        body: batch([event({ name: 'Bad Name' })]),
      })
      expect(response.status).toBe(202)
      expect(body.rejected).toHaveLength(1)
    })
  })

  describe('CORS preflight', () => {
    it('answers preflights for allowed origins without allowing credentials', async () => {
      const { connection } = await host()
      const response = await connection.request('/v1/events', {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
      })
      expect(response.status).toBe(204)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST')
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type')
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    })

    it('refuses preflights from other origins, and for unknown paths', async () => {
      const { connection } = await host()
      for (const origin of ['https://evil.example', undefined]) {
        const response = await connection.request('/v1/events', {
          method: 'OPTIONS',
          headers: origin ? { Origin: origin } : {},
        })
        expect(response.status).toBe(403)
        expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
      }
      const unknown = await connection.request('/v1/nothing', {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN },
      })
      expect(unknown.status).toBe(404)
    })
  })

  describe('other requests', () => {
    it('unknown paths are 404 and wrong methods 405, as problem details', async () => {
      const { connection } = await host()
      const missing = await connection.request('/v2/events', {
        method: 'GET',
        headers: { Origin: ORIGIN },
      })
      expect(missing.status).toBe(404)
      if (!transport.passesUnknownPaths) {
        expect(missing.headers.get('content-type')).toContain('application/problem+json')
      }
      const wrong = await connection.request('/v1/events', {
        method: 'GET',
        headers: { Origin: ORIGIN },
      })
      expect(wrong.status).toBe(405)
      expect(wrong.headers.get('Allow')).toBe('POST, OPTIONS')
      expect(wrong.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    })

    it('every response has a request ID (a well-formed incoming one is kept) and nosniff', async () => {
      const { connection } = await host()
      const kept = await connection.request('/v1/health', {
        method: 'GET',
        headers: { 'X-Request-Id': 'abc-123' },
      })
      expect(kept.headers.get('X-Request-Id')).toBe('abc-123')
      expect(kept.headers.get('X-Content-Type-Options')).toBe('nosniff')
      const replaced = await connection.request('/v1/health', {
        method: 'GET',
        headers: { 'X-Request-Id': 'bad id with spaces' },
      })
      expect(replaced.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/)
    })
  })
})
